#!/usr/bin/env python3
# generate_ass_arabic.py
# الاستخدام: python3 generate_ass_arabic.py "النص" مدة_الصوت مسار_الخط مسار_الخروج

#!/usr/bin/env python3
import subprocess, sys
subprocess.check_call([sys.executable, '-m', 'pip', 'install', 
                       'arabic-reshaper', 'python-bidi', 
                       '--break-system-packages', '-q'])

import arabic_reshaper

def format_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    cs = int((seconds % 1) * 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

def generate_ass(text, audio_duration, font_file, output_path):
    # تقسيم النص إلى chunks من 4 كلمات
    words = text.split()
    chunks = []
    for i in range(0, len(words), 4):
        chunks.append(' '.join(words[i:i+4]))

    if not chunks:
        chunks = [text]

    total_chunks = len(chunks)

    ass_content = """[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Cairo Black,22,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,25,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    current_time = 0.0
    chunk_duration = audio_duration / total_chunks

    for i, chunk in enumerate(chunks):
        start = current_time
        end = min(current_time + chunk_duration, audio_duration - 0.1)

        reshaped = arabic_reshaper.reshape(chunk)
        clean = reshaped.replace('\n', ' ').replace('{', '').replace('}', '')

        ass_content += f"Dialogue: 0,{format_time(start)},{format_time(end)},Default,,0,0,0,,{clean}\n"
        current_time = end + 0.02

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(ass_content)

    print(f"ASS generated: {output_path}")

if __name__ == '__main__':
    text = sys.argv[1]
    duration = float(sys.argv[2])
    font_file = sys.argv[3]
    output = sys.argv[4]
    generate_ass(text, duration, font_file, output)
