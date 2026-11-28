# ADR 0008: Hold settled animation loops in the terminal as Kitty frames

The strips of the sweep, the quit and the orb start draw every frame from a pure function of a scene and a time. While a scene changes, dev streams one full Kitty image per tick. Once the scene has settled into a loop, dev sends that loop to the terminal once, as animation frames that carry only the rectangle around the pixels that changed, and from then on only names the frame to show. Rex is the terminal this is tuned to. The measurements were taken for [#328](https://github.com/taekwondodev/dev/pull/328) by recording a Rex window and counting, per recorded frame, the positions of the moving dot.

## Why this shape

Ways to show a settled loop, measured in Rex with cells of 18×54 px:

| Way                                                            | Output while settled | Positions shown per second |
| -------------------------------------------------------------- | -------------------- | -------------------------- |
| A full image every tick                                        | 250 KiB/s            | 47                         |
| Frames in the terminal, the terminal runs the loop (`a=a,s=3`) | none                 | 26, unevenly spaced        |
| Frames in the terminal, dev names each frame (`a=a,c=<frame>`) | 1.8 KiB/s            | 46 to 50                   |

Rex advances a loop it runs itself at about half the frame rate, so the way that sends nothing looks jerky. Naming the frame also keeps dev's clock: the loop continues from the position the streamed frames reached, a loop needs no gap of whole milliseconds, and the label beside the strip stays in step with the image.

A transition stays streamed. Each of its frames is shown once, so storing them in the terminal would save nothing.

## Adding or changing an animation

1. Draw it as `draw(canvas, scene, t)` in `src/quit-scene.ts`. A frame may depend only on the scene and the time, because the frames of a loop are drawn before the time they are shown.
2. Give the scene an `end(scene)`: the time after which no spring, slide or fade is still running.
3. Give it a `period(scene)`: the length of the loop the settled scene repeats with, and `0` when it stands still. Build it with `loopOf` from the period of every motion still running. The periods must combine into a loop of at most 2000 ms. Otherwise `loopOf` returns `undefined` and the scene keeps streaming. Choose periods that divide each other: the breath of the orb start lasts 1000 ms because it runs beside the 2000 ms orbit, while the breath of the quit runs alone and keeps 1100 ms.
4. Keep a scene immutable and replace the object only when its content changes. The scene object identifies the loop the terminal holds, so a new object sends the loop again.
5. Run it through `sceneStrip` in `src/quit-animation.ts`, or through `loopPlayer` when the strip drives its own loop as the sweep does. Both stream until `end`, draw the loop ten frames per tick while streaming continues so that the switch does not stall, then send the loop and name frames.
6. Add a claim that the pixels at `end + x` equal those at `end + x + period`, as `tests/orb/orb-start-check.ts`, `tests/orb/orb-quit-check.ts` and `tests/workspace/quit-scene-check.ts` do. A scene that does not repeat exactly jumps once per loop.
7. Look at it in Rex. A settled loop must show as many positions per second as the streamed transition before it.

## When a loop is too large for one image

Rex keeps every frame as a full bitmap of the image and refuses frames past a storage limit per image (see [Limits to design around](#limits-to-design-around)). A strip stays far below it. A scene as wide as the terminal does not: at 2448×216 px one image holds 63 frames, and a twenty second loop at twelve frames per second needs 240.

Hold such a scene as layers. dev-hush does this for its working scene in [`lib/working-scene.ts`](https://github.com/taekwondodev/dev-hush/blob/12ac2a2/lib/working-scene.ts):

- What stands still is one opaque image.
- Each thing that moves is a small transparent image whose frames are its poses. A pose is sent the first time it is shown, so nothing is streamed first and no loop is drawn ahead.
- Each tick names the frame when the pose changes, and moves the image with a placement relative to the still image. Movement then costs no frames.

Measured for dev-hush at 136 columns of 18×54 px, for a twenty second loop:

| Way                                                           | Output                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| One PNG of the whole band per tick, 12 positions per second   | 977 KiB/s                                                       |
| Layers with the poses held as frames, 60 positions per second | 8 KiB/s, and about 200 KiB/s while the first loop is being sent |

By the storage rule under [Limits to design around](#limits-to-design-around), the terminal then holds about 58 MiB of frames for the two moving images, so delete them when the scene ends.

## Protocol use

- The first frame is an ordinary strip image: `a=T` with `c`, `r`, `C=1` and `q=2`.
- Each further frame is `a=f,i=<id>,c=<previous frame>,x,y,s,v,X=1`: the rectangle that differs from the previous frame, replacing its pixels. Frame numbers start at 1 with the first frame. A continuation chunk repeats `a=f`.
- `a=a,i=<id>,c=<frame>` shows a frame.
- One image holds one loop. A new loop, a streamed frame, a note above the strip and the end of the strip each delete the image they replace with `a=d,d=I`. Every way out of a strip must leave no image: the strip checks assert that the deleted ids equal the placed ids.

Layers add three uses, each seen working in Rex:

- `a=t` transmits an image without placing it, and `a=f` adds frames to it before any placement exists.
- A frame sent without `c` starts transparent, so a pose needs no previous frame: send only the rectangle it covers, with `x,y,s,v`.
- `a=p,i=<id>,p=1,P=<still image>,H=<cells>,X=<pixels>,z=<layer>` places an image relative to another, without the cursor. Sent again with the same `p`, it moves the image. When the still image's placements are deleted, the relative ones go with them and must be sent again.

## Limits to design around

- Rex does not answer Kitty feature queries (`a=q` with `e=`). It replies `EINVAL: dimensions required`, so support cannot be asked for.
- A block that Rex creates for the command answers the cell-size query with 8×16 px until the client has laid the block out. An existing block answers its real size. A strip sized from the early answer is stretched and soft.
- A terminal that shows Kitty images but does not store animation frames shows a settled scene frozen. This is accepted: dev does not probe for frame support.
- Rex stores a frame as the whole image at four bytes per pixel, whatever rectangle was sent, and answers `ENOSPC: animation frame storage full` to a frame that would take one image past 128 MiB. Naming a frame that does not exist is ignored without a reply, so the scene then shows a stale frame. Keep frames × width × height × 4 below the limit. The 120 frames of a 2000 ms loop leave 279,620 px per frame: a strip of two 54 px rows may be 143 columns of 18 px wide.
- Erasing the display (`CSI 2 J`) frees every image in Rex, data included, while `a=d,d=a` removes only placements. After an erase, `a=p`, `a=a` and `a=f` answer `ENOENT: image not found`. Whatever erases the display must send its images again. Pi's fullscreen renderer erases on every resize and then places the images it tracks by id alone, so an image shown inside Pi's TUI must travel in a line Pi cannot shorten to a placement. dev-hush lost its scene to this when only the height changed.

The last two limits and the layer commands were read from the replies of Rex 0.1.0-preview.20 to commands sent with `q=0`, and seen in a Rex window, for dev-hush [`12ac2a2`](https://github.com/taekwondodev/dev-hush/commit/12ac2a2).

Read this record before adding an animation to a strip, changing a period, changing how strip frames reach the terminal, or holding any other animation in the terminal.
