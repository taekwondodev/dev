# ADR 0008: Hold settled animation loops in the terminal as Kitty frames

The strips of the sweep, the quit and the orb start draw every frame from a pure function of a scene and a time. While a scene changes, dev streams one full Kitty image per tick. Once the scene has settled into a loop, dev sends that loop to the terminal once, as animation frames that carry only the pixels that changed, and from then on only names the frame to show. Rex is the terminal this is tuned to. The measurements were taken for [#328](https://github.com/taekwondodev/dev/pull/328) by recording a Rex window and counting, per recorded frame, the positions of the moving dot.

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

## Protocol use

- The first frame is an ordinary strip image: `a=T` with `c`, `r`, `C=1` and `q=2`.
- Each further frame is `a=f,i=<id>,c=<previous frame>,x,y,s,v,X=1`: the rectangle that differs from the previous frame, replacing its pixels. Frame numbers start at 1 with the first frame. A continuation chunk repeats `a=f`.
- `a=a,i=<id>,c=<frame>` shows a frame.
- One image holds one loop. A new loop, a streamed frame, a note above the strip and the end of the strip each delete the image they replace with `a=d,d=I`. Every way out of a strip must leave no image: the strip checks assert that the deleted ids equal the placed ids.

## Limits to design around

- Rex does not answer Kitty feature queries (`a=q` with `e=`). It replies `EINVAL: dimensions required`, so support cannot be asked for.
- A block that Rex creates for the command answers the cell-size query with 8×16 px until the client has laid the block out. An existing block answers its real size. A strip sized from the early answer is stretched and soft.
- A terminal that shows Kitty images but does not store animation frames shows a settled scene frozen. This is accepted: dev does not probe for frame support.

Read this record before adding an animation to a strip, changing a period, or changing how strip frames reach the terminal.
