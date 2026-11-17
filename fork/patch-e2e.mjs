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
