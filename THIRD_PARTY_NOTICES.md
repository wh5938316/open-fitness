# Third-party notices

OpenFitness code is MIT, as stated in `LICENSE`. The exercise catalogue adds two data sources. Neither ships images, videos, or GIF files.

## ExerciseDB data

Names, body parts, equipment, target muscles, secondary muscles, and English instructions for rows with `source.origin = "exercisedb"` come from the MIT dataset published by Hasan Emir Yıldırım:

- Repository: https://github.com/hasaneyldrm/exercises-dataset
- Commit: `7455efae41b330c265e7cd4b78dfa848e7ce5ebd`

That dataset's license covers its instruction text. Its `images/` and `videos/` directories are Gym visual media and are **not** included here. The license text below is the dataset license, including its media exception, so the boundary stays visible.

```text
MIT License

Copyright (c) 2026 Hasan Emir Yıldırım

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation and data files (the "Software"),
to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
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

------------------------------------------------------------------------------
MEDIA EXCEPTION
------------------------------------------------------------------------------

The MIT license above covers ONLY the code, tooling, dataset structure, and
instruction text/translations in this repository.

It DOES NOT cover the exercise media in the `images/` and `videos/`
directories. That media is © Gym visual (https://gymvisual.com/) and is
included here with the rights holder's written permission, at 180×180
resolution, and must retain the attribution "© Gym visual —
https://gymvisual.com/". Its use and reuse are governed by Gym visual's Terms
& Conditions (https://gymvisual.com/content/3-terms-and-conditions-of-use) and
by `NOTICE.md` in this repository — NOT by the MIT license above. Cloning this
repository does not grant you any license to the media; obtain your own from
Gym visual.
```

OpenFitness does not redistribute that media. Translations shipped by the dataset, including Chinese instructions, are not copied into this catalogue.

ExerciseDB v1 is the upstream exercise collection associated with AscendAPI. This project pins the hasaneyldrm republication above rather than an unpinned mirror.

## openGym catalogue structure

Rows with `source.origin = "opengym"`, movement categories, and `muscleMap` region ids (`primaries`, `secondaries`, `weights`) originate in the openGym catalogue:

- Repository: https://github.com/DuarteSantos8/openGym
- License: AGPL-3.0
- Commit: `e348fc17c42c7e9a211c5972e573ad3698190ee2`
- License text: https://github.com/DuarteSantos8/openGym/blob/e348fc17c42c7e9a211c5972e573ad3698190ee2/LICENSE

Included from that catalogue: exercise id, name, body part, equipment, target, secondary muscles, movement category, muscle-region ids, and which catalogue id is a female or male media variant.

Not included: openGym source code, `zh.json` and other translations, original descriptions or instruction sentences, SVG/body-path geometry, and every image, GIF, or video.

Where a fresh description was written for this project, `needsRewrite` is false. Where it was not, `description` is null and `needsRewrite` is true. Adopted owner copies are ordinary OpenFitness documents and are not updated when the catalogue changes.

## MuscleMap vector diagrams

The four SVGs under `apps/server/public/musclemap/` are generated from `@musclemap/assets` 1.1.0 (flat path data only). The package's photo/webp bodies are not shipped.

OpenFitness adds the hip-flexor, serratus, and upper-back outlines in `apps/server/catalog/musclemap-extra-paths.json`. Those paths are our modification of the MIT diagram. They are merged when the SVGs are generated so a later package update does not erase them. The base geometry remains Jsplice / MuscleMap; the added paths are OpenFitness.

- Package: https://www.npmjs.com/package/@musclemap/assets
- Repository: https://github.com/Jsplice/MuscleMap
- License: MIT
- Copyright: (c) 2026 Jsplice / MuscleMap contributors

```text
MIT License

Copyright (c) 2026 Jsplice / MuscleMap contributors

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
