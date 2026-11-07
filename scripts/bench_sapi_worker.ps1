# A long-running Windows SAPI renderer for scripts/bench_voice_turn.py: one JSON request per stdin line, one JSON answer per
# stdout line. It renders to a stream that stamps the moment the engine first writes audio, which is the closest an OS
# voice gives to "time to first audio". Offline, uses only the voices already installed.
#   request  {"id":1,"text":"...","voice":"Microsoft Zira Desktop","rate":0}
#   answer   {"id":1,"first_write_ms":41.2,"total_ms":163.0,"audio":"<base64 PCM16 mono 16 kHz>"}
Add-Type -AssemblyName System.Speech
Add-Type -TypeDefinition @"
using System; using System.IO; using System.Diagnostics;
public class TimedStream : Stream {
  public MemoryStream Inner = new MemoryStream();
  public Stopwatch Clock = Stopwatch.StartNew();
  public double FirstWriteMs = -1;
  public override bool CanRead { get { return false; } }
  public override bool CanSeek { get { return true; } }
  public override bool CanWrite { get { return true; } }
  public override long Length { get { return Inner.Length; } }
  public override long Position { get { return Inner.Position; } set { Inner.Position = value; } }
  public override void Flush() {}
  public override int Read(byte[] b, int o, int c) { return Inner.Read(b, o, c); }
  public override long Seek(long o, SeekOrigin so) { return Inner.Seek(o, so); }
  public override void SetLength(long v) { Inner.SetLength(v); }
  public override void Write(byte[] b, int o, int c) { if (FirstWriteMs < 0 && c > 0) FirstWriteMs = Clock.Elapsed.TotalMilliseconds; Inner.Write(b, o, c); }
}
"@
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
[Console]::Out.WriteLine('{"ready":true}'); [Console]::Out.Flush()
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if (-not $line.Trim()) { continue }
  $request = $line | ConvertFrom-Json
  if ($request.voice) { try { $synth.SelectVoice($request.voice) } catch {} }
  $synth.Rate = [int]$request.rate
  $stream = New-Object TimedStream
  $synth.SetOutputToAudioStream($stream, $format)
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $stream.Clock = $clock
  $synth.Speak([string]$request.text)
  $total = $clock.Elapsed.TotalMilliseconds
  $bytes = $stream.Inner.ToArray()
  $skip = 0
  if ($bytes.Length -gt 44 -and $bytes[0] -eq 0x52 -and $bytes[1] -eq 0x49 -and $bytes[2] -eq 0x46 -and $bytes[3] -eq 0x46) { $skip = 44 }
  $payload = [Convert]::ToBase64String($bytes, $skip, $bytes.Length - $skip)
  $answer = @{ id = $request.id; first_write_ms = [math]::Round($stream.FirstWriteMs, 1); total_ms = [math]::Round($total, 1); audio = $payload }
  [Console]::Out.WriteLine(($answer | ConvertTo-Json -Compress)); [Console]::Out.Flush()
  $synth.SetOutputToNull()
}
