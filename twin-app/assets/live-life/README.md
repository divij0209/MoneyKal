> **Status:** `background.mp4` no longer ships with the repository.
> live.life.fully was rebuilt as an editorial page and `mountBackdrop()`
> became a no-op, so the clip was downloaded by every visitor and never
> played. `LLF_SCENES.backdrop.src` is `null`; set it to a path here to
> bring a backdrop back. The rest of this file describes that format.

# live.life.fully — background videos

This folder is the drop-in point for the cinematic background videos behind the
`live.life.fully` experience. **No video files ship with the project**, and the
feature does not need them: `js/live-life-scenes.js` renders a procedural scene
(gradient sky + parallax SVG silhouettes + light leaks + particles) for every
entry below, and that is what currently renders.

## `background.mp4` — the backdrop

`background.mp4` is the one clip that plays behind the **whole** experience. It
takes priority over the rotating scenes: once it decodes it crossfades in over
them and the rotation stops, because a single loop under ten alternating
silhouette sets reads as a fault rather than as weather. While it downloads,
and if it is ever missing or fails to decode, the procedural scenes carry on —
nothing about the page depends on the file being there.

It is declared as `BACKDROP` at the bottom of `js/live-life-scenes.js`. Set its
`src` to `null` to go back to the rotating scenes.

Because the footage does not change, the accent colour does: it cycles through
`BACKDROP.accents` on the same eleven-second beat, which is what keeps the hero
word, the glow under the Freedom Balance and the progress paths alive.

The clip is always muted, whether or not it carries an audio track.

## Adding per-scene videos

1. Drop an `.mp4` (H.264, `yuv420p`, no audio track needed — the experience
   never plays sound) into this folder using one of the filenames below. These
   are *per-scene* clips, separate from `background.mp4` above.
2. Open `js/live-life-scenes.js` and set `videosAvailable: true` at the bottom.

That is the whole change. The loader lazily attaches a `<video>` per scene, and
if a file is missing or fails to decode it silently keeps the procedural scene,
so a partial set is fine — add two videos and the other eight stay procedural.

| Filename        | Scene                 |
| --------------- | --------------------- |
| `mountains.mp4` | Mountains             |
| `beach.mp4`     | Beaches & sunsets     |
| `travel.mp4`    | Travel                |
| `concert.mp4`   | Concerts & festivals  |
| `party.mp4`     | Parties & nightlife   |
| `city.mp4`      | City lights           |
| `bonfire.mp4`   | Bonfires & friends    |
| `roadtrip.mp4`  | Road trips            |
| `weekend.mp4`   | Weekend escapes       |
| `adventure.mp4` | Adventure             |

## What makes a clip work here

* **8–15 seconds, seamlessly loopable.** Each scene is on screen for about
  eleven seconds before crossfading.
* **1920×1080 or larger, muted, ~2–4 MB.** They are decoded on the client and
  several may be resident at once.
* **Dark, or dark-tolerant.** Large white type sits over the top third. The
  overlay applies a gradient veil and vignette, but a blown-out sky will still
  fight the copy.
* **Slow camera movement.** The scene layer already drifts and parallaxes;
  fast cuts on top of that read as chaos.

Every clip must be one you have the rights to use. Nothing in this repository
downloads video from a third party at runtime.

Note that `.mp4` is not in `.gitignore`, so anything dropped here is committed
with the repo. Ten clips at a few megabytes each is fine; ten at forty is not.
