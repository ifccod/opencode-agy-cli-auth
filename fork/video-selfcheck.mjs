// 视频补丁自检：容器识别、内网地址拦截。fork/fork.sh test 会跑它。
import assert from "node:assert/strict"

const { sniffVideo, privateAddress } = await import(new URL("../index.mjs", import.meta.url))
const ftyp = (brand) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftyp" + brand, "latin1")])

assert.equal(sniffVideo(ftyp("isom")), "video/mp4")
assert.equal(sniffVideo(ftyp("mp42")), "video/mp4")
assert.equal(sniffVideo(ftyp("qt  ")), "video/quicktime")
assert.equal(sniffVideo(ftyp("heic")), null, "HEIC is an image")
assert.equal(sniffVideo(ftyp("avif")), null, "AVIF is an image")
assert.equal(sniffVideo(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1])), "video/webm")
assert.equal(sniffVideo(Buffer.from("RIFF\0\0\0\0AVI LIST", "latin1")), "video/x-msvideo")
assert.equal(sniffVideo(Buffer.from("\x89PNG\r\n\x1a\n0000", "latin1")), null)

for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
  "224.0.0.1", "::", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
  assert.equal(privateAddress(ip), true, ip)
}
for (const ip of ["8.8.8.8", "142.250.1.1", "172.32.0.1", "100.128.0.1", "2001:4860::8888"]) {
  assert.equal(privateAddress(ip), false, ip)
}

console.log("video selfcheck ok")
process.exit(0)
