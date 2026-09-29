# Third-party code, models and data

| Component | Used for | Licence | Source |
| --- | --- | --- | --- |
| Nanobrowser `buildDomTree.js` (itself derived from browser-use, MIT) | Visibility, interactivity and top-most checks in `extension/lib/dom/elements.ts` (adapted, not copied verbatim) | Apache-2.0 | https://github.com/nanobrowser/nanobrowser |
| Microsoft Presidio India recognizers | Aadhaar (Verhoeff), PAN, GSTIN, passport and voter-ID patterns ported to TypeScript (`lib/pii/validators.ts`) and Python (`server/parda_server/pii.py`); `presidio-analyzer` as an optional server-side scanner | MIT | https://github.com/microsoft/presidio |
| MediaPipe Tasks Vision + BlazeFace short-range model | On-device face detection | Apache-2.0 | https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector |
| Tesseract.js, tesseract.js-core, `eng` LSTM traineddata | On-device OCR for images, canvas and the outgoing-frame re-check | Apache-2.0 | https://github.com/naptha/tesseract.js |
| WXT | Cross-browser extension build | MIT | https://wxt.dev |
| FastAPI, Uvicorn, httpx, spaCy `en_core_web_sm` | Server | MIT | — |
| Playwright | Benchmark and end-to-end harness | Apache-2.0 | https://playwright.dev |
| "This Person Does Not Exist example.jpg" (StyleGAN-generated, not a real person) | Face in the testbed pages | Public domain (Wikimedia Commons) | https://commons.wikimedia.org/wiki/File:This_Person_Does_Not_Exist_example.jpg |
| WebPII / WebRedact (Zhao, ICLR 2026) | Cited as related work and the planned external benchmark; **not bundled** (weights are OpenVINO IR with no licence file) | — | https://webpii.github.io |

All people, numbers and organisations in `testbed/` are synthetic.
