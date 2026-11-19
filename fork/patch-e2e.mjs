// 分叉补丁的端到端测试：经 index.mjs 真实入口 + test/testkit.mjs 的假 agy。
// 上游测试在 AGY_BRIDGE_VIDEO=0 下跑，这里覆盖补丁打开时的行为。fork/fork.sh test 会跑它。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { baseBody, createBridgeKit, readSse } from "../test/testkit.mjs"

async function withKit(fn) {
  const kit = await createBridgeKit({})
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

const sseError = (text) => JSON.parse(text.split("\n").findLast((l) => l.startsWith("data:")).slice(5)).error
const promptText = (kit) => kit.acpLog.filter((e) => e.method === "session/prompt")
  .flatMap((e) => e.params.prompt).map((p) => (p.type === "text" ? p.text : "")).join("")

const BUSY_LINE = "⚠ Our servers are experiencing high traffic right now, please try again in a minute. " +
  "(UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server)"

test("agy's high-traffic ending fails the turn as a 503 overloaded_error, never as the reply", async () => {
  for (const chunks of [["\n" + BUSY_LINE + "\n"], ["\n" + BUSY_LINE.slice(0, 20), BUSY_LINE.slice(20) + "\n"], [BUSY_LINE]]) {
    await withKit(async (kit) => {
      kit.defaultPrompt = async (agent) => {
        for (const chunk of chunks) await agent.text(chunk)
        return { stopReason: "end_turn" }
      }
      const text = await (await kit.request(baseBody({ metadata: { user_id: "busy" }, messages: [{ role: "user", content: "hi" }] }))).text()
      const error = sseError(text)
      assert.equal(error.type, "overloaded_error")
      assert.equal(error.status, 503)
      assert.match(error.message, /no capacity for this model now: Our servers .*gemini-3\.8-flash-high/)
      assert.ok(!text.includes("text_delta"), "nothing of it went as the reply")
    })
  }
})

test("agy's high-traffic ending fails a non-stream request as an HTTP 503", async () => {
  await withKit(async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("\n" + BUSY_LINE + "\n")
      return { stopReason: "end_turn" }
    }
    const response = await kit.request(baseBody({ metadata: { user_id: "busy-json" }, stream: false, messages: [{ role: "user", content: "hi" }] }))
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error.type, "overloaded_error")
  })
})

test("the model quoting the high-traffic line mid-reply keeps it", async () => {
  await withKit(async (kit) => {
    const said = "agy printed `" + BUSY_LINE + "` and then went on.\nThat is all."
    kit.defaultPrompt = async (agent) => {
      await agent.text(said)
      return { stopReason: "end_turn" }
    }
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "busy-quoted" }, messages: [{ role: "user", content: "what did agy print?" }] })))
    assert.equal(parsed.error, null)
    assert.equal(parsed.content.filter((b) => b.type === "text").map((b) => b.text).join(""), said)
  })
})

test("a base64 video image block becomes a read_file prompt, and the file goes once agy has read it", async () => {
  await withKit(async (kit) => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(32)])
    let file = null
    kit.defaultPrompt = async (agent) => {
      const prompt = (agent.prompt || []).map((p) => p.text || "").join("")
      file = prompt.match(/\[Video attached: (\S+) /)?.[1]
      assert.ok(file && fs.existsSync(file), "the bridge wrote the video before the prompt")
      assert.deepEqual(fs.readFileSync(file), mp4)
      agent.update({ sessionUpdate: "tool_call", toolCallId: "call_v", status: "completed", kind: "read",
        rawInput: { Path: file }, locations: [{ path: file }] })
      await agent.text("seen")
      return { stopReason: "end_turn" }
    }
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "video" }, messages: [{ role: "user", content: [
      { type: "text", text: "what is in it?" },
      { type: "image", source: { type: "base64", media_type: "video/mp4", data: mp4.toString("base64") } },
    ] }] })))
    assert.equal(parsed.error, null)
    assert.match(promptText(kit), /Read it with read_file/)
    assert.equal(path.basename(path.dirname(file)), "media")
    for (let i = 0; i < 50 && fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 20))
    assert.ok(!fs.existsSync(file), "the bridge's copy went after agy read it")
  })
})

// agy asks the client to allow its own read_file on a path outside the media
// folder (a client path), as agy 1.5.10 does; returns the bridge's answer.
async function askReadFile(kit, agent, file) {
  const { child } = kit.acpSpawns[kit.acpLog.findLast((e) => e.method === "session/prompt").spawn]
  const answered = new Promise((resolve) => {
    const own = child.onStdin
    child.onStdin = (chunk) => {
      own(chunk)
      for (const line of String(chunk).split("\n")) if (line.includes('"id":"perm"')) resolve(JSON.parse(line))
    }
  })
  child.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: "perm", method: "session/request_permission", params: {
    sessionId: agent.sessionId,
    toolCall: { toolCallId: "call_rf", title: `Read ${file}`, kind: "read" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
  } }) + "\n")
  return (await answered).result
}

test("a turn agy ends at its own denied read_file fails with the reason, not an empty reply", async () => {
  await withKit(async (kit) => {
    kit.defaultPrompt = async (agent) => {
      const answer = await askReadFile(kit, agent, "/Users/someone/video_dl/video.mp4")
      assert.equal(answer.outcome.optionId, "deny")
      return { stopReason: "end_turn" }
    }
    const text = await (await kit.request(baseBody({ metadata: { user_id: "denied" }, messages: [{ role: "user", content: "look at /Users/someone/video_dl/video.mp4" }] }))).text()
    const error = sseError(text)
    assert.equal(error.type, "api_error")
    assert.match(error.message, /agy's own tool \(Read \/Users\/someone\/video_dl\/video\.mp4\).*denied/)
    assert.ok(!text.includes("text_delta"))
  })
})

test("a denied read_file the model answers after is a normal reply", async () => {
  await withKit(async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await askReadFile(kit, agent, "/Users/someone/notes.md")
      await agent.text("I can't open that here.")
      return { stopReason: "end_turn" }
    }
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "denied-then-text" }, messages: [{ role: "user", content: "read /Users/someone/notes.md" }] })))
    assert.equal(parsed.error, null)
    assert.equal(parsed.content.filter((b) => b.type === "text").map((b) => b.text).join(""), "I can't open that here.")
  })
})

// Retry attach (local patch)
const toolRound = (body, parsed, result) => ({ ...body, messages: [...body.messages,
  { role: "assistant", content: parsed.content.filter((b) => b.type === "tool_use").map((b) => ({ type: "tool_use", id: b.id, name: b.name, input: b.input })) },
  { role: "user", content: parsed.content.filter((b) => b.type === "tool_use").map((b) => ({ type: "tool_result", tool_use_id: b.id, content: result })) },
] })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test("tool results sent again while their response still runs get that response, not a 409", async () => {
  await withKit(async (kit) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/a" })
      await gate // the model thinks longer than the client waits
      await agent.tool("Read", { path: "/b" })
      await agent.text("done")
      return { stopReason: "end_turn" }
    })
    const body = baseBody({ metadata: { user_id: "retry-attach" } })
    const first = await readSse(await kit.request(body))
    const second = toolRound(body, first, "A")
    const original = kit.request(second)
    await sleep(30)
    const retried = kit.request(second) // the client gave up on the first byte and sent it again
    await sleep(30)
    release()
    const [a, b] = await Promise.all([original.then(readSse), retried.then(readSse)])
    const calls = (parsed) => parsed.content.filter((x) => x.type === "tool_use").map((x) => [x.id, x.input])
    assert.equal(a.stopReason, "tool_use")
    assert.deepEqual(calls(a).map((c) => c[1]), [{ path: "/b" }])
    assert.deepEqual(calls(b), calls(a), "the retry got the same call")
    assert.equal(b.usage.output_tokens, 0, "and its usage is not counted twice")
    // the reply lost on the way: asked once more after the response ended
    const late = await readSse(await kit.request(second))
    assert.deepEqual(calls(late), calls(a))
    const last = await readSse(await kit.request(toolRound(second, b, "B")))
    assert.equal(last.content.filter((x) => x.type === "text").map((x) => x.text).join(""), "done")
    assert.equal(kit.acpSpawns.length, 1, "one session throughout")
    assert.equal(kit.acpLog.filter((e) => e.method === "session/prompt").length, 1, "and one prompt")
  })
})

test("a retry of a request whose first attempt was cancelled is told to send it again", async () => {
  await withKit(async (kit) => {
    kit.defaultPrompt = async (agent) => { await agent.waitCancel(); return { stopReason: "cancelled" } }
    const body = baseBody({ metadata: { user_id: "retry-cancelled" } })
    const abort = new AbortController()
    const original = kit.request(body, { signal: abort.signal }).then((r) => r.text()).catch(() => "")
    await sleep(30)
    const retried = kit.request(body).then((r) => r.text())
    await sleep(30)
    abort.abort()
    await original
    assert.equal(sseError(await retried).type, "overloaded_error")
  })
})
