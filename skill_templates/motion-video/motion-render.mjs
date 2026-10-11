// Run in the copied project: node motion-render.mjs [--fps 10] [--frame 120]
// --check validates prerequisites; --preview serves the live scrubber until Ctrl+C.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), out = path.join(here, "out");
const args = process.argv.slice(2);
let fps = 30, frame = null, check = false, preview = false;
function valueAt(i, flag) {
  const value = Number(args[i + 1]);
  if (args[i + 1] === undefined || !Number.isFinite(value)) throw new Error(`${flag} needs a number.`);
  return value;
}
function parseArgs() {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fps") { fps = valueAt(i, "--fps"); i++; }
    else if (args[i] === "--frame") { frame = valueAt(i, "--frame"); i++; }
    else if (args[i] === "--check") check = true;
    else if (args[i] === "--preview") preview = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!(fps > 0 && fps <= 120)) throw new Error("--fps must be greater than zero and at most 120.");
  if (frame !== null && (!Number.isSafeInteger(frame) || frame < 0)) throw new Error("--frame must be a nonnegative integer.");
}
function runFFmpeg(args) {
  // No shell: filter quoting is handled in this script on every platform.
  const result = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw new Error(`FFmpeg could not run (${result.error.message}). Install FFmpeg on PATH with permission, then retry.`);
  if (result.status !== 0) throw new Error(`FFmpeg exited ${result.status}: ${result.stderr || result.stdout}`);
  return result;
}
function cachedChromium(chromium) {
  if (process.env.MOTION_CHROMIUM) {
    if (!existsSync(process.env.MOTION_CHROMIUM)) throw new Error("MOTION_CHROMIUM points to a missing executable.");
    return process.env.MOTION_CHROMIUM;
  }
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  // Search installed versions instead of assuming a particular revision number.
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ms-playwright")];
  const layouts = ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome",
    "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac-x64/Chromium.app/Contents/MacOS/Chromium"];
  for (const root of roots.filter(r => r && r !== "0" && existsSync(r))) {
    const revisions = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && /^chromium-\d+$/.test(e.name))
      .map(e => e.name).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const revision of revisions) for (const layout of layouts) {
      const executable = path.join(root, revision, layout);
      if (existsSync(executable)) return executable;
    }
  }
  throw new Error("Playwright's Chromium is missing. Ask before running `npx playwright install chromium` in this project, or set MOTION_CHROMIUM to an installed Chromium executable.");
}
function makeServer() {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".png": "image/png",
    ".svg": "image/svg+xml", ".webp": "image/webp", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".wav": "audio/wav" };
  return http.createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
      if (pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      const file = path.resolve(here, "." + pathname), relative = path.relative(here, file);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404); res.end("Not found"); return;
      }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
      res.end(readFileSync(file));
    } catch { res.writeHead(400); res.end("Invalid request"); }
  });
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 18) throw new Error("Node 18+ is required. Ask before installing Node from nodejs.org or winget.");
  parseArgs();
  runFFmpeg(["-version"]);
  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch (error) { throw new Error(`Playwright could not load: ${error.message}. In the project folder, ask before running npm init -y (if needed), npm install playwright, and npx playwright install chromium.`); }
  const executablePath = cachedChromium(chromium);
  if (check) { console.log(`Node ${process.versions.node}, FFmpeg on PATH, Chromium: ${executablePath}. No installation performed.`); return; }
  if (!existsSync(path.join(here, "motion-starter.html"))) throw new Error("Missing motion-starter.html beside this renderer. Copy all three starter files into the project.");
  const wav = path.join(out, "soundtrack.wav"), video = path.join(out, "video.mp4");
  if (!preview && frame === null && !existsSync(wav)) throw new Error("Missing out/soundtrack.wav. Run `node motion-soundtrack.mjs` first.");
  const server = makeServer();
  let browser, encoder;
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${server.address().port}/motion-starter.html`;
    if (preview) {
      console.log(`Open ${url}?play for visual preview. Ctrl+C stops this server.`);
      await new Promise(resolve => process.once("SIGINT", resolve)); return;
    }
    try { browser = await chromium.launch({ executablePath, headless: true }); }
    catch (error) { throw new Error(`Chromium could not launch: ${error.message}. Check its executable and system libraries; ask before installing anything.`); }
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(url);
    await page.evaluate(async () => { await document.fonts.ready; await window.motionReady; });
    const config = await page.evaluate(() => window.motionConfig);
    if (!config || !Number.isFinite(config.duration) || config.duration <= 0 ||
        !Number.isSafeInteger(config.width) || !Number.isSafeInteger(config.height) ||
        config.width <= 0 || config.height <= 0 || config.width % 2 || config.height % 2) {
      throw new Error("motionConfig needs a positive duration and positive even pixel dimensions for yuv420p.");
    }
    await page.setViewportSize({ width: config.width, height: config.height });
    const frames = Math.ceil(config.duration * fps);
    async function capture(n) {
      if (errors.length) throw new Error("Page errors: " + errors.join("; "));
      const data = await page.evaluate(t => {
        window.drawFrame(t);
        return document.getElementById("canvas").toDataURL("image/png");
      }, n / fps);
      if (errors.length) throw new Error("Page errors: " + errors.join("; "));
      return Buffer.from(data.slice(data.indexOf(",") + 1), "base64");
    }
    mkdirSync(out, { recursive: true });
    if (frame !== null) {
      if (frame >= frames) throw new Error(`--frame must be 0 through ${frames - 1} for ${fps} fps.`);
      const output = path.join(out, `frame-${frame}.png`);
      writeFileSync(output, await capture(frame)); console.log(`${output} at ${(frame / fps).toFixed(6)}s`); return;
    }
    // Reject mismatched timing rather than silently truncating with -shortest.
    const audio = readFileSync(wav);
    if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE" ||
        audio.toString("ascii", 36, 40) !== "data" || audio.readUInt16LE(20) !== 1 ||
        audio.readUInt16LE(22) !== 2 || audio.readUInt32LE(24) !== 48000 || audio.readUInt16LE(34) !== 16) {
      throw new Error("Expected the starter's stereo 48 kHz 16-bit PCM WAV. Run motion-soundtrack.mjs again.");
    }
    const audioDuration = audio.readUInt32LE(40) / audio.readUInt32LE(28);
    if (Math.abs(audioDuration - config.duration) > 1 / 48000) throw new Error(`Audio is ${audioDuration}s but animation is ${config.duration}s. Match BPM and total bars, then regenerate WAV.`);
    encoder = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "pipe:0",
      "-i", wav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-pix_fmt", "yuv420p", "-fps_mode", "cfr", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000",
      "-c:a", "aac", "-b:a", "192k", "-t", String(config.duration), "-movflags", "+faststart", video],
      { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let encoderError = null, stderr = "";
    encoder.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
    const done = new Promise((resolve, reject) => {
      encoder.once("error", reject);
      encoder.once("close", code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}: ${stderr}`)));
    });
    // Handle failure immediately, even if the frame capture is still awaiting Chromium.
    done.catch(error => { encoderError = error; });
    encoder.stdin.on("error", error => { encoderError = error; });
    for (let n = 0; n < frames; n++) {
      const png = await capture(n);
      if (encoderError) throw encoderError;
      // The callback provides backpressure and propagates broken-pipe errors.
      await new Promise((resolve, reject) => encoder.stdin.write(png, error => error ? reject(error) : resolve()));
      if (n % Math.max(1, Math.round(fps * 2)) === 0) console.log(`Frame ${n}/${frames}`);
    }
    encoder.stdin.end(); await done;
    // Select evenly spaced actual frames, including first and final, rather than fps=1.
    const count = Math.min(12, frames), columns = Math.min(4, count), rows = Math.ceil(count / columns);
    const indices = Array.from({ length: count }, (_, i) => count === 1 ? 0 : Math.round(i * (frames - 1) / (count - 1)));
    const filter = `select='${indices.map(n => `eq(n,${n})`).join("+")}',scale=400:-1,tile=${columns}x${rows}:nb_frames=${count}:padding=4:margin=4:color=black`;
    const sheet = path.join(out, "contact-sheet.png");
    runFFmpeg(["-y", "-loglevel", "error", "-i", video, "-vf", filter, "-frames:v", "1", "-fps_mode", "vfr", sheet]);
    console.log(`Rendered ${video}\nContact sheet: ${sheet}\nTile frames (row-major, ${fps} fps): ${indices.join(", ")}\nInspect images, watch and measure audio before calling the video done.`);
  } finally {
    if (encoder && encoder.exitCode === null && encoder.signalCode === null) encoder.kill();
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(`Motion render: ${error.message}`); process.exitCode = 1; });
