// The Windows installer's Microsoft Visual C++ runtime step (electron/vcredist.nsh), checked without installing
// anything: the decision macro is compiled with electron-builder's own makensis into a throwaway test program that
// only reads the registry and writes its answers to a temp file, and is run against a table of registry states plus
// this PC's real registry. The full install function is compiled (never run) to prove it builds, warnings as errors.
// Also checks the pins agree (build_runtime.py vs vcredist.nsh) and the packaging filters from the same fix.
//
// Usage: node scripts/test_vcredist_nsis.cjs
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const electron = path.join(root, 'electron');
const nsh = fs.readFileSync(path.join(electron, 'vcredist.nsh'), 'utf8');
const installer = fs.readFileSync(path.join(electron, 'installer.nsh'), 'utf8');
const buildRuntime = fs.readFileSync(path.join(root, 'scripts', 'build_runtime.py'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(electron, 'package.json'), 'utf8'));

// 1. Static: pins agree, the step is wired in, the flags are Microsoft's documented quiet install.
const define = (name) => Number((nsh.match(new RegExp(`!define ${name} (\\d+)`)) || [])[1]);
const version = (buildRuntime.match(/VC_REDIST_VERSION = "([\d.]+)"/) || [])[1];
assert.ok(version, 'build_runtime.py pins VC_REDIST_VERSION');
const [major, minor, bld] = version.split('.').map(Number);
assert.deepEqual([define('KAIROS_VCRT_MAJOR'), define('KAIROS_VCRT_MINOR'), define('KAIROS_VCRT_BLD')], [major, minor, bld],
  'vcredist.nsh carries the same version build_runtime.py pins');
assert.match(buildRuntime, /VC_REDIST_SHA256 = "[0-9a-f]{64}"/);
assert.match(buildRuntime, /VC_REDIST_URL = \("https:\/\/download\.visualstudio\.microsoft\.com\//);
assert.match(nsh, /ExecWait '"\$PLUGINSDIR\\vc_redist\.x64\.exe" \/install \/quiet \/norestart' \$R5/);
assert.match(nsh, /"\$\{BUILD_RESOURCES_DIR\}\\redist\\vc_redist\.x64\.exe"/);
assert.match(installer, /!include "\$\{BUILD_RESOURCES_DIR\}\\vcredist\.nsh"/);
assert.match(installer, /!macro customInstall\s+Call KairosVcRuntime/);
const filter = pkg.build.extraResources[0].filter;
for (const rule of ['!.git', '!.git/**', '!.venv', '!.venv/**']) assert.ok(filter.includes(rule), 'backend filter has ' + rule);
console.log('static: pins agree (' + version + '), step wired into customInstall, filters exclude .git and .venv links');

// 2. Compile and run the decision macro.
const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'nsis');
const nsisDir = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^nsis-\d/.test(d)).map((d) => path.join(cache, d))
  .find((d) => fs.existsSync(path.join(d, 'Bin', 'makensis.exe'))) : null;
if (!nsisDir) {
  console.log('SKIP: electron-builder has not downloaded NSIS on this machine (build the installer once).');
  process.exit(0);
}
const makensis = path.join(nsisDir, 'Bin', 'makensis.exe');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-vcredist-nsis-'));
const out = path.join(work, 'answers.txt');

const cases = [
  // [Installed, Major, Minor, Bld, run the redistributable?]
  ['', '', '', '', 1],                 // never installed (key absent)
  ['0', '14', '44', '35211', 1],       // key left behind, Installed=0
  ['1', '14', '29', '30133', 1],       // VS 2019-era runtime: older than onnxruntime needs
  ['1', '14', '44', '35210', 1],       // one build older
  ['1', '14', '44', '35211', 0],       // exactly the carried version
  ['1', '14', '44', '35212', 0],
  ['1', '14', '50', '0', 0],
  ['1', '14', '51', '36247', 0],       // newer minor (VS 2026's runtime)
  ['1', '15', '0', '0', 0],
  ['1', '13', '99', '99999', 1],
];
const codes = [[0, 'installed.'], [3010, 'next restart'], [1638, 'newer'], [1602, 'cancelled'], [1603, 'code 1603']];
const nsi = [
  'Unicode true', 'SilentInstall silent', 'RequestExecutionLevel user', `OutFile "${path.join(work, 'vcrt-test.exe')}"`,
  '!include LogicLib.nsh', '!include x64.nsh', '!define KAIROS_VCRT_TEST',
  `!include "${path.join(electron, 'vcredist.nsh')}"`,
  'Section', `  FileOpen $9 "${out}" w`,
  // Through registers, as the installer passes them (ReadRegDWORD leaves an absent value empty).
  ...cases.flatMap(([i, a, b, c], n) => [
    `  StrCpy $1 "${i}"`, `  StrCpy $2 "${a}"`, `  StrCpy $3 "${b}"`, `  StrCpy $4 "${c}"`,
    '  !insertmacro KairosVcRuntimeNeeded $1 $2 $3 $4 $0',
    `  FileWrite $9 "case${n}=$0$\\r$\\n"`]),
  ...codes.flatMap(([code], n) => [
    `  StrCpy $1 ${code}`, '  !insertmacro KairosVcRuntimeResult $1 $0', `  FileWrite $9 "code${n}=$0$\\r$\\n"`]),
  '  !insertmacro KairosVcRuntimeRead $1 $2 $3 $4',
  '  !insertmacro KairosVcRuntimeNeeded $1 $2 $3 $4 $0',
  '  FileWrite $9 "real=$1,$2,$3,$4,$0$\\r$\\n"',
  '  FileClose $9', 'SectionEnd',
].join('\r\n');
fs.writeFileSync(path.join(work, 'vcrt-test.nsi'), nsi);
const env = { ...process.env, NSISDIR: nsisDir };
let compiled = spawnSync(makensis, ['/V2', '/WX', path.join(work, 'vcrt-test.nsi')], { encoding: 'utf8', env });
assert.equal(compiled.status, 0, 'test script compiles:\n' + compiled.stdout + compiled.stderr);
const ran = spawnSync(path.join(work, 'vcrt-test.exe'), [], { encoding: 'utf8' });
assert.equal(ran.status, 0, 'test program ran');
const answers = Object.fromEntries(fs.readFileSync(out, 'utf8').trim().split(/\r?\n/).map((l) => l.split('=')));
cases.forEach(([i, a, b, c, want], n) => {
  assert.equal(Number(answers['case' + n]), want, `Installed=${i} ${a}.${b}.${c}: run=${want}`);
});
codes.forEach(([code, text], n) => assert.ok(answers['code' + n].includes(text), `exit ${code}: ${answers['code' + n]}`));
console.log(`decision: ${cases.length} registry states and ${codes.length} exit codes answered as expected`);

// This PC's real registry (64-bit view), read by `reg` independently.
const reg = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64', '/reg:64'], { encoding: 'utf8' });
const value = (name) => { const m = reg.stdout.match(new RegExp(`^\\s+${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'mi')); return m ? String(parseInt(m[1], 16)) : ''; };
const [ri, ra, rb, rc, rneed] = answers.real.split(',');
assert.deepEqual([ri, ra, rb, rc], [value('Installed'), value('Major'), value('Minor'), value('Bld')], 'installer reads the same values as reg.exe');
const newer = ri === '1' && (Number(ra) > major || (Number(ra) === major && (Number(rb) > minor || (Number(rb) === minor && Number(rc) >= bld))));
assert.equal(rneed, newer ? '0' : '1');
console.log(`this PC: Installed=${ri || '(none)'} ${ra}.${rb}.${rc} -> the installer would ${rneed === '1' ? 'RUN' : 'skip'} the redistributable`);

// 3. The full install function compiles (it is never run here), with the real file when the build has fetched it.
const redist = path.join(electron, 'redist', 'vc_redist.x64.exe');
if (fs.existsSync(redist)) {
  const full = ['Unicode true', 'RequestExecutionLevel user', `OutFile "${path.join(work, 'vcrt-full.exe')}"`,
    '!include LogicLib.nsh', '!include x64.nsh', `!define BUILD_RESOURCES_DIR "${electron}"`,
    `!include "${path.join(electron, 'vcredist.nsh')}"`, 'Section', '  Call KairosVcRuntime', 'SectionEnd'].join('\r\n');
  fs.writeFileSync(path.join(work, 'vcrt-full.nsi'), full);
  compiled = spawnSync(makensis, ['/V4', '/WX', path.join(work, 'vcrt-full.nsi')], { encoding: 'utf8', env });
  assert.equal(compiled.status, 0, 'install function compiles:\n' + compiled.stdout + compiled.stderr);
  assert.match(compiled.stdout, /File: "vc_redist\.x64\.exe"/);
  console.log('full step: compiles with the pinned redistributable packed (not run)');
} else {
  console.log('full step: skipped, electron/redist/vc_redist.x64.exe not fetched yet (scripts/build_runtime.py)');
}
fs.rmSync(work, { recursive: true, force: true });
console.log('PASS: vcredist installer step');
