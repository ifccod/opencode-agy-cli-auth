// 分叉补丁的端到端测试：经 index.mjs 真实入口 + test/testkit.mjs 的假 agy。
// 上游测试在 AGY_BRIDGE_VIDEO=0 下跑，这里覆盖补丁打开时的行为。fork/fork.sh test 会跑它。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { baseBody, createBridgeKit, readJson, readSse } from "../test/testkit.mjs"

async function withKit(fn, options = {}) {
  const kit = await createBridgeKit(options)
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

// Video (local patch): an OpenAI image_url video, inline or by link, reaches
// upstream's media staging (view_file, the session's attachments folder).
test("a video sent as an image block, inline or by link, goes to agy as a file for view_file", async () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(32)])
  let fetched = 0
  const server = http.createServer((req, res) => { fetched++; res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(mp4) })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${server.address().port}/clip`
  try {
    await withKit(async (kit) => {
      const files = []
      kit.defaultPrompt = async (agent) => {
        const prompt = (agent.prompt || []).map((p) => p.text || "").join("")
        for (const m of prompt.matchAll(/attached a video: (\S+?)\. Read it/g)) files.push(m[1])
        await agent.text("seen")
        return { stopReason: "end_turn" }
      }
      const ask = (block, user) => kit.request(baseBody({ model: "gemini-3.8-flash-high", metadata: { user_id: user }, messages: [{ role: "user", content: [
        { type: "text", text: "what is in it?" }, block] }] }))
      assert.equal((await readSse(await ask({ type: "image", source: { type: "base64", media_type: "video/mp4", data: mp4.toString("base64") } }, "inline"))).error, null)
      assert.equal((await readSse(await ask({ type: "image", source: { type: "url", url } }, "link"))).error, null)
      assert.equal((await readSse(await ask({ type: "video", source: { type: "url", url } }, "link-video"))).error, null)
      assert.equal(files.length, 3, "each prompt names a staged file")
      for (const file of files) {
        assert.equal(path.basename(path.dirname(file)), "attachments")
        assert.deepEqual(fs.readFileSync(file), mp4)
      }
      assert.equal(fetched, 1, "a link fetched once is read from the cache")
      assert.ok(!kit.acpSpawns.some((s) => (s.args || []).join(" ").includes("magpie-agy-bridge/media")), "the download cache is no agy folder")
    }, { env: { AGY_BRIDGE_VIDEO_PRIVATE: "1" } })
  } finally {
    server.close()
  }
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

// Parallel lanes (local patch)
const textOf = (parsed) => parsed.content.filter((b) => b.type === "text").map((b) => b.text).join("")
const replyTurn = (body, parsed, next) => ({ ...body, messages: [...body.messages,
  { role: "assistant", content: [{ type: "text", text: textOf(parsed) }] }, { role: "user", content: next }] })
async function withEvents(fn) {
  const events = []
  const write = process.stderr.write
  process.stderr.write = function (chunk, ...args) {
    if (String(chunk).startsWith("[agy-bridge] ")) { events.push(JSON.parse(String(chunk).slice(13))); return true }
    return write.call(this, chunk, ...args)
  }
  try { return await fn(events) } finally { process.stderr.write = write }
}
const laneAgent = (kit, gate) => {
  kit.defaultPrompt = async (agent) => {
    const text = agent.prompt.map((p) => (p.type === "text" ? p.text : "")).join("")
    const now = text.slice(text.lastIndexOf("<current_turn>") + 1)
    if (now.includes("TOOL")) {
      await agent.tool("Read", { path: now.includes("SIDE") ? "/side" : "/main" })
      await agent.text(now.includes("SIDE") ? "side done" : "main done")
      return { stopReason: "end_turn" }
    }
    if (now.includes("SLOW")) await gate
    await agent.text(now.includes("SIDE") ? "side reply" : "main reply")
    return { stopReason: "end_turn" }
  }
}
const laneKit = process.env.LANES_PROBE ? { env: { AGY_BRIDGE_MAX_LANES: "1" } } : {}
const sessionsOpened = (kit) => kit.acpLog.filter((e) => e.method === "session/new").length

test("two lines of one conversation take turns with their tool rounds: no 409, and each keeps a session of its own", async () => {
  await withEvents(async (events) => withKit(async (kit) => {
    laneAgent(kit)
    const first = baseBody({ metadata: { user_id: "lanes-tools" }, messages: [{ role: "user", content: "hello" }] })
    const opened = await readSse(await kit.request(first))
    const main = replyTurn(first, opened, "MAIN TOOL")
    const mainCall = await readSse(await kit.request(main))
    assert.equal(mainCall.stopReason, "tool_use")
    // the side task starts from the same conversation while main's tool runs:
    // upstream's rule supersedes main's waiting call, as for any line that moved on
    const side = replyTurn(first, opened, "SIDE TOOL")
    const sideCall = await readSse(await kit.request(side))
    assert.equal(sideCall.stopReason, "tool_use")
    // main was not done with it: its result comes back and replays in a lane
    const mainRound = toolRound(main, mainCall, "main file")
    const mainDone = await kit.request(mainRound)
    assert.equal(mainDone.status, 200)
    const mainEnd = await readSse(mainDone)
    assert.equal(mainEnd.stopReason, "end_turn") // agy got the history with its result
    const sideRound = toolRound(side, sideCall, "side file")
    const sideDone = await kit.request(sideRound)
    assert.equal(sideDone.status, 200)
    const sideEnd = await readSse(sideDone)
    assert.equal(textOf(sideEnd), "side done")
    // from here each line goes on in its own session, no replay
    const opens = sessionsOpened(kit)
    assert.equal(textOf(await readSse(await kit.request(replyTurn(mainRound, mainEnd, "MAIN again")))), "main reply")
    assert.equal(textOf(await readSse(await kit.request(replyTurn(sideRound, sideEnd, "SIDE again")))), "side reply")
    assert.equal(sessionsOpened(kit), opens)
    assert.deepEqual(events.filter((e) => e.action === "reject_active"), [])
  }, laneKit))
})

test("a line that left another's running stream gets a lane at once, not a busy wait", async () => {
  await withEvents(async (events) => withKit(async (kit) => {
    let release
    laneAgent(kit, new Promise((resolve) => { release = resolve }))
    const first = baseBody({ metadata: { user_id: "lanes-stream" }, messages: [{ role: "user", content: "hello" }] })
    const opened = await readSse(await kit.request(first))
    const step = replyTurn(first, opened, "MAIN step")
    const slow = replyTurn(step, await readSse(await kit.request(step)), "MAIN SLOW")
    const running = kit.request(slow).then(readSse)
    await sleep(30)
    const side = await kit.request(replyTurn(first, opened, "SIDE quick"))
    assert.equal(side.status, 200)
    assert.equal(textOf(await readSse(side)), "side reply", "answered while main still streams")
    release()
    assert.equal(textOf(await running), "main reply")
    assert.equal(events.filter((e) => e.action === "lane" && e.reason === "attached").length, 1)
  }, laneKit))
})

test("tool results that match no call here (the conversation came back from another host) replay in a lane, not a 409", async () => {
  await withEvents(async (events) => withKit(async (kit) => {
    let release
    laneAgent(kit, new Promise((resolve) => { release = resolve }))
    const first = baseBody({ metadata: { user_id: "lanes-foreign" }, messages: [{ role: "user", content: "hello" }] })
    const opened = await readSse(await kit.request(first))
    const step = replyTurn(first, opened, "MAIN step")
    const slow = replyTurn(step, await readSse(await kit.request(step)), "MAIN SLOW")
    const running = kit.request(slow).then(readSse)
    await sleep(30)
    const foreignId = "toolu_" + "ab".repeat(12)
    const foreign = replyTurn(first, opened, "SIDE read it")
    foreign.messages.push({ role: "assistant", content: [{ type: "tool_use", id: foreignId, name: "Read", input: { path: "/x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: foreignId, content: "x" }] })
    const response = await kit.request(foreign)
    assert.equal(response.status, 200)
    await readSse(response)
    release()
    assert.equal(textOf(await running), "main reply")
    assert.deepEqual(events.filter((e) => e.action === "reject_active"), [])
  }, laneKit))
})

test("AGY_BRIDGE_MAX_LANES=1 keeps upstream's one process per conversation", async () => {
  {
    await withEvents(async (events) => withKit(async (kit) => {
      laneAgent(kit)
      const first = baseBody({ metadata: { user_id: "lanes-off" }, messages: [{ role: "user", content: "hello" }] })
      const opened = await readSse(await kit.request(first))
      const mainCall = await readSse(await kit.request(replyTurn(first, opened, "MAIN TOOL")))
      assert.equal(mainCall.stopReason, "tool_use")
      await readSse(await kit.request(replyTurn(first, opened, "SIDE TOOL")))
      assert.equal(events.filter((e) => e.action === "superseded").length, 1)
      assert.equal(events.filter((e) => e.action === "lane").length, 0)
    }, { env: { AGY_BRIDGE_MAX_LANES: "1" } }))
  }
})

// Thinking when disabled (local patch)
function thinkingAgent(kit) {
  kit.defaultPrompt = async (agent) => {
    await agent.thought("**Planning**\n\nWork it out first.")
    await agent.text("The answer.")
    return { stopReason: "end_turn" }
  }
}

test("thinking: disabled still streams agy's thoughts as signed thinking_delta blocks", async () => {
  await withKit(async (kit) => {
    thinkingAgent(kit)
    const body = baseBody({ metadata: { user_id: "think-off" }, thinking: { type: "disabled" },
      messages: [{ role: "user", content: "hi" }] })
    const streamed = await readSse(await kit.request(body))
    const deltas = streamed.events.filter((e) => e.data?.delta?.type === "thinking_delta")
    assert.equal(deltas.map((e) => e.data.delta.thinking).join(""), "**Planning**\n\nWork it out first.")
    assert.equal(streamed.content[0].type, "thinking")
    assert.match(streamed.content[0].signature, /^agyb1\.[A-Za-z0-9_-]{43}$/)
    assert.deepEqual(streamed.content.slice(1), [{ type: "text", text: "The answer." }])

    // the non-stream answer carries the same signed block
    const json = await readJson(await kit.request({ ...body, stream: false,
      metadata: { user_id: "think-off-json" } }))
    assert.equal(json.content[0].type, "thinking")
    assert.match(json.content[0].signature, /^agyb1\./)
    assert.equal(json.content.at(-1).text, "The answer.")
  })
})

test("AGY_BRIDGE_THINKING_WHEN_DISABLED=0 drops the thoughts of a thinking: disabled request, as upstream does", async () => {
  await withKit(async (kit) => {
    thinkingAgent(kit)
    const body = baseBody({ metadata: { user_id: "think-off-upstream" }, thinking: { type: "disabled" },
      messages: [{ role: "user", content: "hi" }] })
    const streamed = await readSse(await kit.request(body))
    assert.ok(!streamed.events.some((e) => e.data?.delta?.type === "thinking_delta"), "no thinking_delta")
    assert.deepEqual(streamed.content, [{ type: "text", text: "The answer." }])
  }, { env: { AGY_BRIDGE_THINKING_WHEN_DISABLED: "0" } })
})

// Thinking when disabled: disabled picks the lowest level (agy has no "off"),
// the request's own output_config.effort first; a suffixed model keeps its suffix.
async function launchedModel(kit, extra, user, model = "agy-cli/gemini-4-argon") {
  kit.defaultPrompt = async (agent) => { await agent.text("ok"); return { stopReason: "end_turn" } }
  await readSse(await kit.request(baseBody({ model, metadata: { user_id: user }, ...extra,
    messages: [{ role: "user", content: "hi " + user }] })))
  const set = kit.acpLog.filter((e) => /set_model|set_config_option/.test(e.method)).at(-1)
  return set?.params?.modelId ?? set?.params?.value
}

test("thinking: disabled runs agy at the lowest level, or the request's output_config.effort", async () => {
  await withKit(async (kit) => {
    assert.equal(await launchedModel(kit, { thinking: { type: "disabled" } }, "off-low"), "gemini-4-argon-low")
    assert.equal(await launchedModel(kit, { thinking: { type: "disabled" }, output_config: { effort: "medium" } }, "off-medium"), "gemini-4-argon-medium")
    assert.equal(await launchedModel(kit, {}, "unset"), "gemini-4-argon-high", "no thinking field keeps the default")
    assert.equal(await launchedModel(kit, { thinking: { type: "disabled" } }, "off-suffixed", "agy-cli/gemini-4-argon-high"), "gemini-4-argon-high")
  })
})

test("AGY_BRIDGE_DISABLED_EFFORT=0 keeps upstream's default level for thinking: disabled", async () => {
  await withKit(async (kit) => {
    assert.equal(await launchedModel(kit, { thinking: { type: "disabled" } }, "off-upstream"), "gemini-4-argon-high")
  }, { env: { AGY_BRIDGE_DISABLED_EFFORT: "0" } })
})
