# Engine review, September 2026

This review measures what the composer does and proposes how to make it more interesting.

**Where the numbers come from.**
- **Addresses 1 to 20,000.** Every figure measured over these comes from the lab in `tools/lab/`: a copy of Edition 1's engine with each proposed change behind a flag. With every flag off it reproduces Edition 1 note for note (`verify.mjs`).
- **The first 100,000 and 2,000,000 addresses.** These figures come from the site's Catalogue exploration, which composed every address up to No. 2,000,000 and traced every draft thrown away in the first 100,000. Its scripts were scratch files and are not in this repo; an independent fact-check re-derived its 100,000-address figures.

**The unit.** A *draft* is one tune with its bass and inner voices. When a draft fails, the engine throws the tune away and draws a new one. The main measure below is the share of addresses that keep their first draft.

## The short version

What works today:
- every piece passes the checker;
- a piece takes about 12 ms to compose;
- no address in the first 2,000,000 is empty.

There are three problems.

**A. Some pieces end off the tonic.** 128 of the first 20,000 end with the bass off the tonic (about one in 160). Another 50 end on the tonic chord with the tune stranded on its third. The planner won't place a cadence note below B♭3 (MIDI 58); when the note it needs lies below that and the next one up is out of reach, it repeats the note it is on. Nothing checks the final chord.

**B. The bass line isn't checked against the soprano.**
- It never tests the pair for parallel octaves or fifths. 14% of bass lines contain one, and nearly all of them come from the fallback the bass search uses when Bach's table has no data.
- It can climb right up to the soprano. In 71% of the drafts whose inner voices can't be written, the bass meets or crosses the soprano somewhere. Among drafts that do harmonize, 4% have the bass meeting the soprano, always in unison.
- Either way the tune is thrown away. Today 37% of addresses discard at least one tune.

**C. The pieces are fragments.** Bach's chorales run about six phrases of eight notes, around 50 chords. The machine writes two to four phrases of four to six notes, about 15 chords, and no phrase comes back within a piece. Short tunes recur across the library: 438 of the first 20,000 addresses play a tune (same key and soprano) that another address also plays.

**What fixes them.**
- **A and B: eight small changes, now Edition 2's engine.** The first draft is kept at 97.7% of addresses, up from 63.2%. No piece ends off the tonic and no soprano leaves its range. Every key is equally easy, and the engine makes 44% fewer harmonization attempts.
- **C: bar form.** The planner writes chorale tunes as their opening phrases stated twice, then new ones. As built in #6, its pieces average 44 chords, 96.9% of the first 20,000 addresses keep their first draft, and only 4 of them share a tune. After form comes modulation.

**What's built.** Almost every change renumbers much of the library, so existing links stay on a frozen Edition 1 and the improvements form Edition 2, released on 26 September:
- [#1](https://github.com/DashWieland/choral-counterpoint/pull/1): Edition 1 hardening.
- [#5](https://github.com/DashWieland/choral-counterpoint/pull/5): the machine's CSS taken verbatim from the site (the commit #1 missed).
- [#2](https://github.com/DashWieland/choral-counterpoint/pull/2): editions.
- [#3](https://github.com/DashWieland/choral-counterpoint/pull/3): Edition 2's fixes.
- [#6](https://github.com/DashWieland/choral-counterpoint/pull/6): bar form in Edition 2.
- [#7](https://github.com/DashWieland/choral-counterpoint/pull/7): Edition 2 released, frozen in `engine-ed2.js`; [dash_website#78](https://github.com/DashWieland/dash_website/pull/78) puts it on the site.

Later that day Dash retired editions: Edition 2 is strictly better, so every address now plays it, and old links open the new piece at their number.

## Decisions for you

| Decision | Recommendation |
|---|---|
| Adopt editions: old links play Edition 1 forever; the crank moves to Edition 2 at release | **Adopted, then retired (26 Sept).** Once Edition 2 was out, Dash chose to roll it out fully rather than keep Edition 1 reachable. |
| Release the fixes on their own, or hold Edition 2 for bar form | **Hold (26 Sept, with bar form); released the same day.** Release once: an edition is a promise to keep every address forever, and the plate will show it. If bar form stalls, release the fixes alone. Until then, about one piece in 160 keeps ending off the tonic. |
| The edition mark on the plate | Keep the quiet `· ED. 2` built in #2, shown only past Edition 1. |
| Bar form: repeat the opening phrases literally or re-harmonize them | **Literal (26 Sept).** In the listening session the two were hard to tell apart, so the tie-breakers decide: many of Bach's hymn settings write the Stollen once under a repeat sign, and a copied repeat is a smaller search. The closing reprise is still re-harmonized, so the ending moves. |
| Piece length under the crank | **Accepted (26 Sept)** with bar form: a median of 46 seconds at the machine's 66 bpm, against 16 today. |
| The plate's "N PHRASES" | Show the real phrase count, which the planner can report. |
| Settings ("No. 214, setting 2") on the machine | **Parked (26 Sept).** In the listening session three settings of one tune were hard to tell apart. |
| Bring your own tune, on the site | Optional, after the release. |
| An Edition 3 with modulation | Worth a research lane once bar form ships. |

Dash listened to the examples on 26 September and chose bar form. `tools/lab/listening.mjs` renders them as WAV files with the project's choir at 66 bpm, with a page that plays each pair side by side.

## Findings

### 1. Wrong endings

Of the first 20,000 pieces, 128 end with the bass off the tonic (`endings.mjs`). By the final bass note:

| Final bass note | Pieces |
|---|---|
| the fifth | 47 |
| the fourth | 41 |
| the sixth (♭6 in minor, 6 in major) | 25 |
| the second | 12 |
| ♭7 | 3 |

Another 50 end on the tonic chord with the tune stranded on its third, and one on vi6. Two examples:
- No. 550 (F major) ends on a diminished triad, E–G–B♭, over B♭. Its tune closes B♭3, B♭3, B♭3.
- No. 990 (G minor) ends with all four voices on the same C.

**Cause.**
- `melody()` places each note of a cadence formula (a three-note closing pattern taken from Bach's tunes) as near the previous note as it can, but never below B♭3 (MIDI 58).
- When the note it needs lies below that and the next instance is more than six semitones up, it repeats the previous note, so a tune that sits low stalls before its final tonic.
- The bass search penalizes a non-tonic ending but allows it, and no checker rule covers the final chord.
- The same code is why 1,812 of the 20,000 pieces carry a soprano-out-of-range warning. 1,691 of them dip below C4 through the clamp; 121 climb above A5 when a formula leaves the window.

**Fix.**
- `formulaFit` places the formula as a unit inside the soprano's range, C4 to A5, and tries Bach's other formulas for the same cadence before giving up. That takes range warnings from 1,812 to 0 and melodic wrong endings from 119 to 0.
- `tonicEnd` makes the tonic ending a hard rule in the bass search. On its own it changes only the 128 pieces that end wrongly.

### 2. Soprano/bass parallels

The pipeline writes the soprano, then the bass, then the inner voices.
- `bassLine()` (`bass_line` in compose.py) rewards contrary motion but never tests soprano against bass for parallels.
- `harmonize()` rejects a parallel in any of the six voice pairs but can't change the soprano or the bass, so a soprano/bass parallel always kills the draft.

What `sixth_pair.mjs` found over the first three drafts at addresses 1 to 3,000:
- 13.6% of bass lines contain a soprano/bass parallel, and 74% of those parallels are octaves.
- The common shapes are textbook ones: the leading tone doubled in both outer voices and rising to the tonic; 2→♭3 in octaves in minor; VI→V in fifths in minor.

**Nearly every parallel comes from the oracle's fallback.**
- When Bach's corpus has no example of the soprano's move from the bass's current note, the search falls back to the `arrivals` table: the bass notes Bach used under the soprano's new note, wherever the bass came from.
- Fallback steps are 9% of all steps, but they produce all 1,285 parallels in this sample, and all but 3 of 26,395 in the first 100,000 addresses.

**Fix.**
- `sbParallel` rejects the parallel inside the bass search. Tunes thrown away per address drop from 0.83 to 0.56.
- `bassAug2` does the same for the minor-key augmented second (♭6–♯7) in the bass, which the checker would otherwise kill later. On its own it barely moves the numbers.
- **Not yet measured:** make the fallback remember where the bass came from. Before using bare arrivals, try Bach's moves from the same bass degree, then moves of the same kind (step, leap, repeat). That should also improve bass lines that never form a parallel.

### 3. The bass crowds the soprano

Across the first 100,000 addresses the engine threw away 81,394 drafts:
- 97% in the inner-voice search;
- 1.7% in the bass search;
- 1.4% at the checkers.

An exact search over the harmonizer's own rules finds no valid alto and tenor under the bass in 97% of those inner-voice failures. The fix belongs in the bass search.

**Cause.**
- The bass may go as high as D4 (MIDI 62), and the soprano window, the band of notes a key's tune is drawn from, can start at C4.
- The bass search considers the two octaves nearest its last note, and rewards contrary motion (+0.6) more than it penalizes a bass above C4 (−0.3). So when the tune dips, the bass can climb into it.
- `crowding.mjs` finds the bass meeting or crossing the soprano somewhere in 71% of the drafts whose inner voices failed (addresses 1 to 3,000). Among drafts that harmonized it is 4%, all of them unisons. A bass on the soprano's note leaves room only for all four voices in unison, and a bass above it leaves none.

**Fix.**
- `bassSpace` keeps the bass at least a major third below the soprano. On its own it cuts inner-voice failures by 75% (16,030 to 3,965 in the first 20,000). Tunes thrown away per address drop from 0.83 to 0.22, and the worst address needs 7 drafts instead of 25.

**Two smaller changes, left out of Edition 2.**
- `bassFallback`: a failed draft today throws its tune away without trying the other nine bass lines already in the beam. Trying them first raises the first draft kept from 97.7% to 99.0%.
- `exactInner`: exact dynamic programming finds valid inner voices the beam misses. No. 12,041, the example number on the Hurdy-Gurdy page, threw away a clean first draft that a width-20 beam finds. It adds little once `bassSpace` is on.

### 4. Register

The soprano window is built from the tonic above middle C, so in C and D the tonic sits at the bottom of the soprano's range. Mean drafts per piece are 3.41 in C and 2.62 in D, against 1.24 in A. Twelve of the fifteen hardest addresses in the first 100,000 are in C minor.

Most of this was the crowding in finding 3. With Edition 2's rules every key needs between 1.01 and 1.05 drafts per piece. Edition 2 also uses one soprano band, D4 to F♯5, for every key (`register`). On its own that band raises wrong endings, but with `formulaFit` it doesn't, so a band chosen per key isn't needed.

### 5. Seams into cadence formulas

The free notes of a minor-key tune (every note outside the cadence formulas) come from the natural minor.
- **Augmented seconds.** Two of Bach's minor-key formulas begin on the raised seventh, which the window doesn't contain, so the planner has nothing to aim at. Every one of the 413 soprano augmented seconds in the first 100,000 addresses is ♭6 leaping to ♯7 into one of those formulas.
- **Tritones.** Free notes never form a tritone, so the rising tritones in 2.3% of pieces all come from formula notes, inside a formula or at its seam.

`seamFix` steers toward the formula's real first note and avoids entering it by a tritone or augmented second whenever the tune allows. `formulaFit`'s placement forbids a tritone entry outright. Under Edition 2's rules, 9 drafts in 20,000 still enter by ♭6→♯7; the checker rejects them. On its own `seamFix` makes endings worse, because it steers more tunes into low formulas that then stall at the B♭3 floor (finding 1). It belongs with `formulaFit`.

### 6. Smaller defects

- **The Python engine crashed on some seeds.** `compose.py:118` called `rng.choices` on an empty list. For example, `python engine/compose.py --tonic Bb --mode major --phrases 3 --seed 105`: 4 of 900 B♭-major compositions crashed, and none in the other 13 keys and modes. The JS port hits the same case and writes `undefined` notes that die in the bass search. Fixed in both: #1 discards such a melody in Python, and #3 removes the cause in both engines.
- **The engines disagreed on augmented seconds in the inner voices.**
  - Python rejects, everywhere, ♭6–♯7 and any three-semitone move that touches a chromatic note.
  - JS rejected only ♭6–♯7, only in minor, and not across a fermata.
  - The surface gate (the check run after ornaments are added) has no fermata exemption in either language. So JS wrote moves across fermatas that its own gate then rejected: 233 wasted drafts per 100,000 addresses.
  - Edition 2 uses one rule everywhere (`innerRules`), which takes those rejections to zero.
- **"The same piece for everyone" depended on the last bit of `Math.log1p`.** The JavaScript standard lets each browser approximate `log1p`, and Chrome's result differs from the correctly rounded one for 32 of the first 1,601 integers. Under a correctly rounded `log1p`, 3 of the first 3,000 pieces change: Nos. 432, 1,979 and 2,942. Firefox and Safari are untested. #1 freezes Chrome's values, so every browser plays Chrome's pieces.
- **`?piece=` parsing** accepted fractions, hex and Infinity, and some addresses above 2^53 froze the tab. Fixed in #1.
- **The README** promised a "never-before-heard chorale for every turn of the handle". Fixed in #1.
- **The site's copy of `hurdy-gurdy.css`** had drifted from upstream by about 19 lines (signal ink, then the type roles). #1 makes upstream identical, with the standalone page defining the tokens.

## Making it more interesting

### Length and form

Lutheran chorale tunes are usually in bar form (AAB). A Stollen of one to three phrases is sung twice, then an Abgesang of new phrases follows, often closing with a phrase that recalls the Stollen. The repeat gives a listener something to recognize.

`tools/lab/barform.mjs` is a drop-in melody planner that writes this form:
- The address's phrase count (2, 3 or 4) sets the size of the form.
- Phrases take hymn-meter lengths of 6 to 8 notes.
- There is one climax, in the Abgesang.
- The Stollen closes on the tonic in about half of tunes. About a third of those end with a reprise of its closing phrase.
- It allows what the shipped planner forbids and real chorale tunes do: repeated notes, triadic motion, a leap of up to a sixth at the start of a phrase, and a tonic cadence at the end of the Stollen.

Measured over addresses 1 to 3,000 with Edition 2's rules:

| | Shipped planner | Bar form, the prototype you heard | Bar form as built (#6) |
|---|---|---|---|
| Chords per piece | 15.1 | 44.0 | 44.1 |
| Addresses that keep their first draft | 97.7% | 95.3% | 97.2% |
| Soprano motion: step / repeat / third | 76 / 13 / 4.5% | 65 / 14 / 14% | 69 / 14 / 10% |
| Soprano span | about a sixth | about an octave | about an octave |
| Warnings per 10 chords | 0.23 | 0.35 | 0.34 |
| Length at 66 bpm, median (most pieces) | 16 s (9–26 s) | 46 s (32–57 s) | 46 s (32–57 s) |

As built, the repeat is copied (below), and each phrase's free notes are drawn from every legal completion rather than by a depth-first search. The prototype's column comes from the lab before that change (commit 23fb9f3).

- **Against Bach.** His sopranos, counted at each soprano onset in the oracle's corpus with sixths folded into thirds, step about 70% of the time, repeat 15% and move by a third 8%. The shipped planner moves by thirds too rarely. The prototype did so 15% of the time: its depth-first search fell back on whatever was left after a dead end, and 36% of those redraws were thirds. Drawn from every legal completion, and with a phrase's opening and peak weighted by the distance they leave to cover, the built planner is at 11%, and steps at 69%. Down-weighting thirds directly, the degree prior and the contour pull each moved it by a point or less.
- **Duplicate tunes.** As built, 4 of the first 20,000 addresses share a tune (2 under the prototype); today 438 do.
- **The extra warnings** are mostly doubled leading tones under a soprano leading tone. In major keys the new tunes sit on the seventh degree a little more often than Bach's do, and on the fourth a little less.
- **Cost.** A bar-form piece takes about 21 ms to compose in Node, against 13, and three times as long to play.

**Listening examples** of the prototype, addresses 1 to 4 (not cherry-picked), in `docs/engine-review/examples/`:
- `shipped-000N.mid` is what `?piece=N` plays today.
- `barform-000N.mid` is the same address under Edition 2's rules with the bar-form planner.
- `plain-varied-000N.mid` and `plain-literal-000N.mid` are those bar-form pieces without ornaments, with the Stollen repeat re-harmonized or copied.
- `barform-sopranos.txt` lists every tune with its phrases lettered.

**The repeat.**
- In the prototype, the bass search carries on from the Stollen's last chord into the repeat, so 96% of repeats get a new harmonization, with about half the chords changed.
- Many of Bach's four-part settings write the Stollen once under a repeat sign. He does re-harmonize a repeated Stollen elsewhere, for example in the chorale chorus of BWV 114.
- **Copying works everywhere.** Copying the first statement's harmony into the repeat passes the checker in all 3,000 pieces tested (`barform-literal.mjs`). It adds 0.42 warnings per piece, at the two phrase breaks where the copy joins the rest.
- So a literal repeat is purely a musical choice; the decision table has this row. `plain-varied-000N.mid` and `plain-literal-000N.mid` are the same four pieces without ornaments, differing only in the repeat's harmony.
- **As built (#6), the repeat is copied, ornaments included.** Inside it the bass and inner-voice searches may only repeat what they wrote the first time. Measured over addresses 1 to 3,000 with the built planner:
  - re-harmonized, 95.0% of first drafts are kept; copied, 94.9%, once a line at the Stollen's last chord must be able to start over (in the prototype, copying without that check cost 3.4 points);
  - the move back to the Stollen's start needs no precedent in the oracle, since a repeat starts over after a breath: 95.8%;
  - a bass line at the next-to-last chord must be able to reach the tonic, where `tonicEnd` made the beam die: 96.5%, and 97.2% with Edition 2's seeding. Wider beams bought under a point.

**Limits.**
- No motivic link between Stollen and Abgesang, no text rhythm, and no key plan beyond cadence degrees.
- Thirds at 11%, against Bach's 8%.
- C and D tunes end on C5 and D5. Ending them on C4 and D4, now that the bass keeps a third below the soprano, loses first drafts in those keys (97% to 93% in C, 98% to 94% in D) and lowers the whole choir by about three semitones, so they stay high.
- Adopting it renumbers every address.

### A wider melody grammar

The shipped planner forbids things chorale tunes often do:
- after any leap larger than a whole step the next note must step back, so a tune can't outline a triad;
- no repeated free notes;
- no sixth, even at the start of a phrase;
- no middle phrase ending on the tonic.

Some consequences:
- **Claude's own chorale can't be written by the machine.** FABE's second phrase ends on the tonic, which the planner allows only at the very end of a piece.
- **An exhaustive search of the planner's rules shows it can't write Amazing Grace or the Old Hundredth either.**
- Of 40 random eight-note tunes, mostly stepwise, 26 cannot occur at any address.

Bar form lifts most of these limits.

### Several settings of one tune

For each tune the engine plays one harmonization, the beam's best, out of billions the rules allow. The Catalogue exploration counted about 2.5 billion valid inner-voice settings for the eight-chord No. 477 alone.

- **The beam's own alternatives are near copies.** The other bass lines left in the beam almost all pass (9.45 of 10 on average), but they change the bass on only 10% of chords and the harmony on 17%.
- **Choosing for difference gives real alternatives.** `diverse.mjs` widens the bass beam to 60, keeps every line that harmonizes and passes the checker, and picks the best line followed by whichever lines differ most from those already chosen. Of 300 tunes, 290 got three settings; the other 10 got no valid setting from the widened beam. On average the alternatives change the bass on 28% of chords and the harmony on 37%.

Bach set the same tune many times: the St Matthew Passion uses one chorale melody in five movements, with four different harmonizations. The machine could offer "No. 214, setting 2", where setting 1 is the edition's piece, so nothing renumbers. `docs/engine-review/examples/settings-0006-{1,2,3}.mid` are three settings of one G-major tune.

**Parked.** In the listening session the three settings were hard to tell apart. No. 6 changes its chords about as often as the average (38% against 37%) but its bass less than most (16%, in the bottom tenth of the 290 tunes).

### Modulation

Every phrase in the machine cadences in the home key. The engine does tonicize: it offers a secondary dominant wherever the next bass note is its target, and about a quarter of pieces have one. But it never establishes a new key. Bach's inner cadences usually land in a related key (the dominant, or the relative major or minor), and that key plan is a chorale's largest-scale structure.

SKILL.md already names the obstacle: the oracle's degrees are relative to the global key, so modulation blurs its counts. The path:
1. Re-mine the outer-voice table by local key: segment each chorale at its fermatas and estimate each phrase's key.
2. Let the melody planner pick a key plan, for example I → V → vi → I.
3. Plan each phrase in its local key and query the oracle there.

This is the largest change on the list and the one a listener would notice most. It comes after bar form, because a key plan needs more than three phrases.

### Bring your own tune

The Python engine already harmonizes a given melody (`compose.py --melody`). Given FABE's own soprano, it finds a clean setting on its second attempt, with three warnings. The JS port needs only an entry point, a `harmonizeTune(soprano, fermatas, key)` that skips `melody()`. On the website that would let a visitor bring a tune the library can't contain and hear the machine set it.

## Editions and the plan

Almost every change renumbers:

| Change | Share of the first 20,000 pieces that change |
|---|---|
| `tonicEnd` | 0.6% |
| `innerRules` | 2.2% |
| `bassAug2` | 2.6% |
| `seamFix` | 23.1% |
| `bassFallback` | 26.6% |
| `sbParallel` | 28.4% |
| `formulaFit` | 30.4% |
| `bassSpace` | 51.0% |
| `register` | 51.4% |
| `exactInner` | 61.1% |
| Edition 2's rules | 80.5% |
| Edition 2 as built (with its new seeding) | all of them |

Part of each share is ornaments alone. After a flag changes which lines the bass search expands, the ornamenter reads a shifted random stream, so some pieces keep their notes and change only their decorations. That is about 10 of the 28.4 points for `sbParallel`.

**Editions.**
- Edition 1 is frozen (`engine-ed1.js`, `tables-ed1.js`), and a golden test checks its pieces 1 to 20,000.
- A link without `?ed=` plays Edition 1 forever.
- `engine.js` is the working copy of the next edition.
- A fresh visit plays the current edition, and a URL can open only released editions.

**Edition 2's seeding.**
- Edition 1 seeded with `n*2654435761` and `n*1000 + 7a + 13` in floating point, where `a` is the draft number:
  - the compose seed repeats every 2^29 addresses, so No. n + 2^29 is No. n whenever key, mode and phrase count also match (2.7% of the time; No. 10 and No. 536,870,922 are one piece);
  - the key seed loses precision above No. 3,393,263;
  - above about 7 × 10^15 every piece is in D minor with two phrases, and some addresses can't compose.
- Edition 2 hashes the address with splitmix64. Its census gives the same 97.7% on the first 20,000 addresses and on 2,000 addresses spread up to 2^53, with nothing empty.

**How a change passes.** Every change starts as a lab flag and runs over the first 20,000 addresses.
- A change that must not renumber passes if Edition 1's golden digests hold.
- A change that renumbers passes if the promoted code reproduces the lab's pieces address for address, which `engine.js` did for Edition 2's rules at all 20,000 addresses.
- A change the lab can't reproduce, such as new seeding, passes the census: first draft kept at 97% or more of addresses, and no empty address, wrong ending or range warning.

Both engines change in the same commit; Python is a sibling, checked by its own census.

**The lanes.**
1. **This review and the lab**, in this pull request.
2. **Edition 1 hardening, #1.** The `?piece=` clamp, the golden test, frozen `log1p`, the Python crash, the README, and CSS parity. Renumbers nothing.
3. **Editions, #2.** Nothing audible changes.
4. **Edition 2's fixes, #3.**
   - `engine.js` matches the lab at all 20,000 addresses.
   - The new seeding passes its census.
   - `compose.py` takes the same rules: over 2,520 pieces its first draft kept rises from 63.5% to 98.3%, and off-tonic endings fall from 25 to 0.
   - New property tests and `census.mjs`.
5. **Bar form, #6.**
   - `engine.js` matches the lab at all 20,000 addresses; the census keeps the first draft at 96.9% there and at 97.4% of 2,000 addresses up to 2^53.
   - Thirds down from 15% to 11%; C and D tunes stay high, as measured above.
   - The repeat is literal; the plate shows the real phrase count.
   - `compose.py` takes the same design (`engine/census.py`: first draft kept 96.9% over 2,520 pieces).
   - Then a listening session: matched key, register and tempo, per CLAUDE.md.
6. **Edition 2, released 26 September** ([#7](https://github.com/DashWieland/choral-counterpoint/pull/7), [dash_website#78](https://github.com/DashWieland/dash_website/pull/78)).
   - `engine-ed2.js` and `tables-ed2.js` are frozen with `golden-ed2.json`; `RELEASED` and `CURRENT` are 2; the site vendors both editions.
   - Still to do: rewrite the lines on the site page that aren't true. They are your prose, so the rewrites are yours: "every chorale that obeys the rules already sits at some address", "the music no one has heard is further out", the G example (in Edition 1 the 25th G phrase arrives by No. 100,080), and "infinite". Since the release, "No. 12,041 is the same four voices for every visitor, forever" holds per edition: the page's link keeps its Edition 1 piece, but a visitor who cranks to No. 12,041 today hears Edition 2's.
7. **After the release.** Bring-your-own-tune. Settings are parked.
8. **Edition 3, if you want it: modulation.** Research first: re-mining the oracle needs music21 and the corpus, and `tools/cleanroom_eval.py` measures the result against Bach.

**The site.** [dash_website#77](https://github.com/DashWieland/dash_website/pull/77) re-vendored #1, and [dash_website#78](https://github.com/DashWieland/dash_website/pull/78) vendors both editions.

## Measurements

Addresses 1 to 20,000 (`tools/lab/results/summary.json`). Most single fixes make some other number worse on their own. For example, `bassSpace` alone lets more drafts survive, including tunes whose endings stalled, so its wrong-ending and range counts rise. Edition 2's rules are chosen so that each fix covers another's side effects.

| Flags | Tunes thrown away per address | First draft kept | Harmonization attempts per address | Pieces with any warning | Wrong endings (bass / tune) | Soprano out of range |
|---|---|---|---|---|---|---|
| Edition 1 | 0.83 | 63.2% | 1.81 | 7,086 | 128 / 119 | 1,812 |
| `sbParallel` | 0.56 | 73.2% | 1.55 | 7,216 | 225 / 109 | 1,794 |
| `bassAug2` | 0.82 | 63.4% | 1.81 | 7,092 | 130 / 119 | 1,806 |
| `bassSpace` | 0.22 | 83.0% | 1.21 | 7,247 | 178 / 163 | 2,418 |
| `tonicEnd` | 0.84 | 62.7% | 1.81 | 7,032 | 0 / 52 | 1,749 |
| `formulaFit` | 0.68 | 67.2% | 1.67 | 5,871 | 69 / 0 | 0 |
| `seamFix` | 0.80 | 62.6% | 1.79 | 7,113 | 370 / 382 | 2,268 |
| `seamFix` + `formulaFit` | 0.68 | 66.9% | 1.68 | 5,643 | 68 / 0 | 0 |
| `register` | 0.63 | 65.2% | 1.62 | 6,495 | 234 / 216 | 1,388 |
| `innerRules` | 0.82 | 63.3% | 1.81 | 7,156 | 128 / 119 | 1,823 |
| `bassFallback` | 0.18 | 85.9% | 3.48 | 7,079 | 343 / 154 | 2,061 |
| `exactInner` | 0.77 | 64.6% | 1.75 | 6,584 | 138 / 124 | 1,912 |
| **Edition 2's rules** (the eight above, from `sbParallel` to `innerRules`) | **0.02** | **97.7%** | **1.02** | **5,497** | **0 / 0** | **0** |
| Edition 2's rules + `bassFallback` | 0.01 | 99.0% | 1.08 | 5,500 | 0 / 0 | 0 |
| **Edition 2 as built, with bar form** (#6: `barform`, `literalRepeat`, `joinFree`, `endLookahead`, `splitmixSeed`) | **0.03** | **96.9%** | **1.03** | **12,836** | **0 / 0** | **0** |

Bar form's pieces are three times as long, so more of them carry a warning: 0.34 per ten chords, against 0.23 with the shipped planner.

To reproduce, see `tools/lab/README.md`. For Edition 2 as built:

```bash
cd instrument/web && node census.mjs 1 20000
```
