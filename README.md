# Canva Native Designer

Create editable social media graphics in Canva using native text, shapes, lines, and library icons.

An AI skill for social media marketers, content creators, and anyone who wants a clear design workflow with editable elements. When direct Canva creation is unavailable, it provides a visual mockup and detailed instructions for rebuilding the design manually.

## What it helps you create

- Social media posts and carousels.
- Stories, covers, banners, and video thumbnails.
- Adaptations of existing designs to different formats.
- Layouts with consistent typography, colors, spacing, and visual hierarchy.

## How it works

### Direct Canva creation

When the host AI platform has an authorized Canva integration that can create and inspect editable designs, the skill guides it to:

1. Define the brief, format, content, and visual direction.
2. Build the design with native Canva elements.
3. Check the preview, text, layout, and element editability.
4. Present the preview for approval before confirming pending changes or exporting.
5. Deliver the approved preview and editing link when supported.

Some integrations save drafts automatically during creation.

### Manual reconstruction

If the integration is unavailable, lacks the required capabilities, reaches a quota, or cannot verify the design, the skill switches to a manual workflow:

- A visual mockup of the intended design.
- Exact text, colors, dimensions, positions, and typography.
- Numbered Canva reconstruction instructions.
- PNG or standalone SVG output when supported; SVG code in text-only environments.

Mockups are illustrative references. Rebuild their components as native Canva elements to keep the final design editable.

## Setup and requirements

The instruction file is [SKILL.md](skills/canva-native-designer/SKILL.md).

1. Download this repository using **Code → Download ZIP**, or copy the skill folder.
2. If your AI platform supports custom skills, follow its installation process and supply the skill folder or archive in the format it requires.
3. Otherwise, provide the contents of SKILL.md as task instructions in your AI conversation.
4. For direct creation, connect and authorize a Canva integration with design creation and inspection capabilities.

This repository contains instructions, not a standalone application or a Canva integration. Installation formats and available tools vary by platform. Publishing the repository does not establish cross-platform compatibility; no platform compatibility test matrix is provided here.

The instructions are currently written mainly in Italian and ask the assistant to respond in the user's language.

## Example prompts

### LinkedIn banner

> Use Canva Native Designer to create a LinkedIn profile banner for a junior social media marketer. Use navy and light blue, native Canva elements only, and leave room for the profile photo. Text: “Gianmarco Franceschini” and “Junior Digital Marketing & Social Media”. Check the current platform dimensions before creating the final layout.

### Educational carousel

> Create a five-slide Instagram carousel explaining keyword research to beginners. Use an educational tone, short English copy, a consistent blue palette, and editable native Canva elements. Include a cover, three practical teaching slides, and a closing slide. Use 1080 × 1350 px pages.

### Manual Canva guide

> Create a manual Canva reconstruction guide for a square event announcement. Include a visual mockup, exact text, HEX colors, font sizes, element coordinates, and numbered steps. Use native shapes and text only. Ask me for the event details before designing.

## What to include in your brief

For a more useful result, specify the platform, format, objective, audience, exact copy, number of pages, preferred colors, and any brand guidelines. Mention whether you want a new design or an adaptation.

## Limitations

- Direct Canva creation depends on the host platform's tools, permissions, and quotas.
- The skill does not provide Canva account access or bypass subscription restrictions.
- Native element editability must be verified before a design is presented as directly editable.
- Font and icon availability can vary; simple native shapes and lines are the fallback.
- A generated mockup or imported image is not itself a fully editable Canva design.
- Platform dimensions should be checked when final placement requirements matter.

## Repository contents

| Path | Purpose |
| --- | --- |
| `skills/canva-native-designer/SKILL.md` | Complete design workflow and fallback instructions |
| `README.md` | Overview, setup guidance, examples, and limitations |

## Feedback

Use this repository's Issues tab to report unclear instructions or suggest improvements. Include your host platform, intended format, and expected result. Remove private information before sharing examples.
