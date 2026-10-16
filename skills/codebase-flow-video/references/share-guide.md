# Share guide: the post that goes with the video

Write `flow-video/share.md` after rendering, so the user can post straight away. It follows the same accuracy rules as the video: every claim comes from `FLOW.md`, nothing about speed, scale, security or results unless the code proves it, no secrets, internal hostnames or customer names. Do not claim the video was "generated from the code" unless the full workflow (graph → FLOW.md → verify → storyboard) actually ran.

```markdown
# Share copy

## LinkedIn
<Hook: one line about the problem the product solves, for the audience (clients, executives, investors).>

<1-2 sentences: what the product is.>

How it works:
→ <step 1 in plain words>
→ <step 2>
→ <the key decision or safety check>
→ <the result the business cares about>

<One sentence on why it matters. Optional call to action: link, demo request, "DM me".>

#<3-5 relevant hashtags>

## X / short
<Max 280 characters: hook + what it does + link placeholder.>

## Video description (YouTube / website)
<2-3 sentences, then the scene list as chapters: 0:00 Intro, 0:05 <scene 1 title>, … from render.mjs --check timings.>

## Alt text
<One sentence describing the video for screen readers.>
```

Guidance:

- Write for the `--audience` the user chose (default: LinkedIn / non-technical). Executives: outcome and risk. Clients: what it does for them. Developers: architecture and the interesting technical choice.
- Hooks are concrete ("Every invoice is read, matched and scheduled for payment, with a person only when it matters"), never generic ("Revolutionising finance with AI").
- Mention the upload format: LinkedIn feed = `flow-1x1.mp4`, Reels/Shorts/Stories = `flow-9x16.mp4`, YouTube/meetings = `flow-16x9.mp4`.
- If the code is the user's employer's or a client's, remind them to check they may publish it.
