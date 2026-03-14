#!/usr/bin/env python3
# ===== process.py =====
# معالجة الفيديو بـ MoviePy — Ken Burns + Fade + Color Grading

import sys
from moviepy import VideoFileClip, ImageClip, TextClip, CompositeVideoClip, concatenate_videoclips

def process_section(input_path, output_path, media_type, duration, on_screen_text):
    """
    يعالج section واحد ويضيف التأثيرات الاحترافية
    """

    if media_type == 'image':
        # Ken Burns Effect — الصورة تتحرك ببطء
        clip = ImageClip(input_path).with_duration(duration)
        # zoom in تدريجي من 100% إلى 110%
        clip = clip.resized(lambda t: 1 + 0.1 * (t / duration))

    else:
        # فيديو عادي
        clip = VideoFileClip(input_path)
        if clip.duration < duration:
            # تكرار الفيديو إذا كان أقصر من الصوت
            loops = int(duration / clip.duration) + 1
            clip = concatenate_videoclips([clip] * loops).subclipped(0, duration)
        else:
            clip = clip.subclipped(0, duration)

    # Fade in/out
    clip = clip.with_effects([
        __import__('moviepy.video.fx', fromlist=['FadeIn']).FadeIn(0.5),
        __import__('moviepy.video.fx', fromlist=['FadeOut']).FadeOut(0.5)
    ])

    # Lower Third — نص أسفل الشاشة
    if on_screen_text and on_screen_text.strip():
        try:
            txt = TextClip(
                text=on_screen_text,
                font_size=28,
                color='white',
                bg_color='black',
                size=(clip.w, None),
                method='caption'
            ).with_duration(min(4, duration)).with_position(('center', 'bottom'))
            clip = CompositeVideoClip([clip, txt])
        except Exception as e:
            print(f"[process.py] TextClip warning: {e}")

    # حفظ النتيجة بدون صوت — الصوت يُضاف لاحقاً بـ FFmpeg
    clip.without_audio().write_videofile(
        output_path,
        fps=30,
        codec='libx264',
        preset='ultrafast',
        logger=None
    )

    clip.close()
    print(f"[process.py] Done: {output_path}")

if __name__ == '__main__':
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    media_type = sys.argv[3]
    duration = float(sys.argv[4])
    on_screen_text = sys.argv[5] if len(sys.argv) > 5 else ''

    process_section(input_path, output_path, media_type, duration, on_screen_text)
