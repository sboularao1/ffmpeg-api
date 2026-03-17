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
    # تقسيم النص إلى جمل
    import re
    sentences = re.split(r'[.!?؟،,،]\s*', text)
    sentences = [s.strip() for s in sentences if len(s.strip()) > 2]

    if not sentences:
        sentences = [text]

    total_words = len(text.split())
    
    # ASS header
    ass_content = """[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Cairo Black,20,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    current_time = 0.0

    for i, sentence in enumerate(sentences):
        words = sentence.split()
        if not words:
            continue

        sentence_words = len(words)
        sentence_duration = (sentence_words / max(total_words, 1)) * audio_duration
        sentence_end = min(current_time + sentence_duration + 0.3, audio_duration - 0.1)

        # reshape العربية للعرض الصحيح
        display_text = arabic_reshaper.reshape(sentence)
        # تنظيف للـ ASS
        display_text = display_text.replace('\n', ' ').replace('{', '').replace('}', '')

        start_fmt = format_time(current_time)
        end_fmt = format_time(sentence_end)

        ass_content += f"Dialogue: 0,{start_fmt},{end_fmt},Default,,0,0,0,,{display_text}\n"

        current_time = sentence_end + 0.05

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(ass_content)

    print(f"ASS generated: {output_path}")

if __name__ == '__main__':
    text = sys.argv[1]
    duration = float(sys.argv[2])
    font_file = sys.argv[3]
    output = sys.argv[4]
    generate_ass(text, duration, font_file, output)
