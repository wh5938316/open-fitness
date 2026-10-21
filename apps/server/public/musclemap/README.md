# Muscle map diagrams

These four files are generated flat SVGs:

- `male-front.svg`
- `male-back.svg`
- `female-front.svg`
- `female-back.svg`

They are served at `/musclemap/<file>`. Path geometry comes from the MIT package `@musclemap/assets` (`MALE_FRONT`, `MALE_BACK`, `FEMALE_FRONT`, `FEMALE_BACK`), viewBox `0 0 1024 1536`. The photo/webp bodies in that package are not used.

Each muscle path has `data-surface` (for example `CHEST_LEFT`) and, when the catalogue region matches, `data-region` (for example `chest`). Catalogue exercises still store openGym-style `muscleMap` region ids. `diagram.highlights` and `list_exercise_taxonomy` map those ids onto MuscleMap groups and surface ids.

Regenerate after a package upgrade:

```sh
pnpm --filter @openfitness/server musclemap:svg
```

Regions with no traced surface in `@musclemap/assets` 1.1.0: `hip-flexors` (`HIP_FLEXORS` is empty) and `serratus` (no group). `upper-back` uses latissimus and rhomboid surfaces because `BACK_UPPER` has no path. See `apps/server/catalog/musclemap-regions.json`.
