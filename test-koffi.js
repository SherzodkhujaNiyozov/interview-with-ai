// Quick sanity test: can we load koffi and resolve SetWindowDisplayAffinity?
const koffi = require("koffi");

try {
  const user32 = koffi.load("user32.dll");
  const SetWindowDisplayAffinity = user32.func(
    "__stdcall",
    "SetWindowDisplayAffinity",
    "bool",
    ["void *", "uint32"]
  );
  console.log("✓ koffi loaded user32.dll");
  console.log("✓ SetWindowDisplayAffinity resolved:", typeof SetWindowDisplayAffinity);
  console.log("Platform:", process.platform, "Arch:", process.arch);
  console.log("Node version:", process.version);
  console.log("\nReady — native hide should work on Windows 10 build 19041+ / Windows 11");
} catch (err) {
  console.error("✗ Failed:", err.message);
}
