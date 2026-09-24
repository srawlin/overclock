// Miniature repro: does pi's system prompt include the FASTCODE_GUIDANCE section?
const piPkg = "@mariozechner/pi-coding-agent"
const mod = await import("/Users/srawlin/dev/cerebras-test/fastcode-pi/node_modules/@mariozechner/pi-coding-agent/dist/index.js")
console.log("exports:", Object.keys(mod).filter(k => /system|prompt/i.test(k)))
