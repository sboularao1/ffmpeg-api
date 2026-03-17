#!/usr/bin/env python3
# ===== kokoro_tts.py =====
import sys
import subprocess

# تثبيت المكتبات في نفس Python executable
result = subprocess.run([
    sys.executable, '-m', 'pip', 'install',
    'soundfile', 'kokoro', '--break-system-packages', '-q'
], capture_output=True, text=True)

print(f"[kokoro_tts] pip stdout: {result.stdout}", flush=True)
print(f"[kokoro_tts] pip stderr: {result.stderr}", flush=True)
print(f"[kokoro_tts] pip returncode: {result.returncode}", flush=True)

# إعادة تحميل مسارات Python بعد التثبيت
import importlib
import site
importlib.reload(site)

# الآن نستورد
import soundfile as sf
from kokoro import KPipeline

def generate(text, voice, output_path, lang='en-us'):
    pipeline = KPipeline(lang_code=lang)
    generator = pipeline(text, voice=voice, speed=1.0)
    
    import numpy as np
    audio_chunks = []
    sample_rate = 24000
    
    for samples, _, _ in generator:
        audio_chunks.append(samples)
    
    if audio_chunks:
        audio = np.concatenate(audio_chunks)
        sf.write(output_path, audio, sample_rate)
        print(f"[kokoro_tts] Done: {output_path}")
    else:
        raise Exception("No audio generated")

if __name__ == '__main__':
    text        = sys.argv[1]
    voice       = sys.argv[2]
    output_path = sys.argv[3]
    lang        = sys.argv[4] if len(sys.argv) > 4 else 'en-us'
    generate(text, voice, output_path, lang)
