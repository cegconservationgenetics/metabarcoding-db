# Curated Primer Database Explorer

An interactive website for browsing curated, primer-specific reference databases
used in DNA metabarcoding research.

Open the website, choose a primer, and explore the database. Nothing needs to be
installed, built, or run.

---

## Research context

**Project**
DNA Metabarcoding-based diet diversity and niche differences of three otter
species in Thailand

**Research Group** — Conservation Genetics Group
**Program** — Conservation Ecology Program (CEG)
**Institution** — King Mongkut's University of Technology Thonburi (KMUTT)

These curated databases were developed to support DNA metabarcoding analyses by
providing taxonomically annotated reference sequences associated with individual
metabarcoding primer regions.

---

## What the website shows

| Tab | Purpose |
| --- | --- |
| Research Context | Project information and how to interpret the data |
| Database Overview | Summary statistics and data quality for one primer |
| Taxonomy Explorer | Browse Class → Order → Family → Genus → Species |
| Species Search | Find a species and see its lineage |
| Primer Comparison | Check which databases contain a given species |
| Taxonomic Composition | Composition of the reference database by rank |
| Feature Explorer | Browse, filter, and export individual reference sequences |

---

## Data format

Each database is a tab-separated file in the `data/` folder with two columns:

```
Feature_ID	Taxonomy
AA539195.1	d__Metazoa;p__Arthropoda;c__Insecta;o__Diptera;f__Drosophilidae;g__Drosophila;s__melanogaster
```

Rank prefixes:

```
d__ Domain    p__ Phylum    c__ Class    o__ Order
f__ Family    g__ Genus     s__ Species
```

Incomplete taxonomy is handled safely. Missing ranks are left blank and are never
guessed or filled in.

**Species counting.** A unique species is counted as *Genus + species epithet*
together, so `g__Drosophila;s__melanogaster` is counted as *Drosophila
melanogaster*. Two different genera sharing the same epithet remain two separate
species. A record with a genus but no epithet counts toward the genus only; a
record with an epithet but no genus is not counted as a species.

---

## Adding another database

1. Name the file `<PrimerName>_tax.tsv` and put it in the `data/` folder.
2. Open `app.js` and add the file name to the short list near the top:

```js
const DEFAULT_FILES = [
  '12SV5_tax.tsv',
  'COI175_tax.tsv',
  'fwh2_tax.tsv',
  'mlCOIint_tax.tsv',
  'Vert16S_tax.tsv',
  'MyNewPrimer_tax.tsv'
];
```

3. Commit and push. The new primer appears in every dropdown automatically.

If you prefer not to edit `app.js`, you can instead create a file called
`data/index.json` listing the file names, and it will be used instead:

```json
["12SV5_tax.tsv", "MyNewPrimer_tax.tsv"]
```

---

## Publishing with GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings → Pages**.
3. Under **Source**, choose the `main` branch and the `/ (root)` folder.
4. Save. The site appears at
   `https://USERNAME.github.io/metabarcoding-primer-db/`.

Large files may take a few seconds to load the first time. Each database is
loaded only when selected and stays cached for the rest of the session.

> GitHub blocks individual files larger than 100 MB. If a `.tsv` exceeds this,
> either split it or store it with Git LFS.

---

## Interpreting the results

**"Reference sequence present"** means only this:

> A corresponding reference sequence is present in the curated database.

It does **not** mean that the species will be amplified by the primer, that it
was detected in any sample, that it occurs at the study site, that it
contributed to otter diet, or that the primer is specific to that species.

The number of reference sequences reflects how the reference database was
assembled. **It must not be interpreted as ecological abundance.**
