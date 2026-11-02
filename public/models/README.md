# Detection models

These files run on the user's device. They are never downloaded from anywhere else at runtime.

| File | What it finds | Source | Licence | SHA-256 |
|---|---|---|---|---|
| `face-yunet-2023mar.onnx` | Faces | [OpenCV Zoo, YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) (`face_detection_yunet_2023mar.onnx`) | MIT (below) | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| `text-ppocrv3-det.onnx` | Text (signs, names, numbers) | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv3 detection model `ch_PP-OCRv3_det_infer.onnx`, as converted to ONNX by [RapidOCR](https://github.com/RapidAI/RapidOCR) (`rapidocr_onnxruntime` 1.2.3) | Apache-2.0 | `3439588c030faea393a54515f51e983d8e155b19a2e8aba7891934c1cf0de526` |
| `person-yolox-s.onnx` | Whole people (optional) | [YOLOX](https://github.com/Megvii-BaseDetection/YOLOX) release `0.1.1rc0`, `yolox_s.onnx` (COCO; the "person" class is used; original SHA-256 `c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063`), weights stored as float16 with `scripts/half_weights.py` (same results, half the size) | Apache-2.0 | `1e3d798ab3a3dabd87d84878bc2ae2a59a787ec17ba1f3bcddf3071759bdc222` |
| `person-seg-u2netp.onnx` | Outlines of people (for silhouette covers) | [U-2-Net](https://github.com/xuebinqin/U-2-Net) small model `u2netp`, ONNX as published by [rembg](https://github.com/danielgatis/rembg) release `v0.0.0` | Apache-2.0 | `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8` |
| `plate-yolov9t-640.onnx` | Licence plates | [open-image-models](https://github.com/ankandrew/open-image-models) release `assets`, `yolo-v9-t-640-license-plates-end2end.onnx` | MIT (below) | `c3c1026ca7d0585dd88084d68182dd897113712fa734ae1557ca70174440c076` |

Note: the plate model was trained with the YOLOv9 training code, which is GPL-3.0. The model publisher releases the
weights under MIT. We ship the weights unchanged as separate files.

The text, person and outline models are used under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0); it is shipped
unchanged.

## YuNet licence

```
MIT License

Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.```

## open-image-models licence

```
MIT License

Copyright (c) 2024 ankandrew

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
