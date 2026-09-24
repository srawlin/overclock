// Miniature repro: does pi's system prompt include the OVERCLOCK_GUIDANCE section?
const piPkg = "@earendil-works/pi-coding-agent"
const mod = await import("/Users/srawlin/dev/cerebras-test/overclock-pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js")
console.log("exports:", Object.keys(mod).filter(k => /system|prompt/i.test(k)))
