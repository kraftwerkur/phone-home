#!/usr/bin/env python3
"""YOLOv8 Nano person detection for Phone Home.

Usage: python detect_person.py <image_path>
Exit code 0 + prints JSON with detections if person(s) found.
Exit code 1 if no person detected.
Exit code 2 on error.

JSON output: {"persons": [{"confidence": 0.85, "bbox": [x1,y1,x2,y2]}], "count": 1}
"""

import sys
import json
from pathlib import Path

def detect(image_path: str) -> dict:
    from ultralytics import YOLO
    
    model = YOLO("yolov8n.pt")  # auto-downloads ~6MB on first run
    results = model(image_path, verbose=False, conf=0.35)
    
    persons = []
    for r in results:
        for box in r.boxes:
            cls_id = int(box.cls[0])
            if cls_id == 0:  # COCO class 0 = person
                conf = float(box.conf[0])
                bbox = box.xyxy[0].tolist()
                persons.append({"confidence": round(conf, 3), "bbox": [round(x, 1) for x in bbox]})
    
    return {"persons": persons, "count": len(persons)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: detect_person.py <image_path>", file=sys.stderr)
        sys.exit(2)
    
    img = sys.argv[1]
    if not Path(img).exists():
        print(f"File not found: {img}", file=sys.stderr)
        sys.exit(2)
    
    try:
        result = detect(img)
        print(json.dumps(result))
        sys.exit(0 if result["count"] > 0 else 1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(2)
