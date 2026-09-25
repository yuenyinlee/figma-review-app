# Web Design System Reference

<!--
  This file replaces live Figma reference images for design-system checking
  on web reviews. Condensed from the team's detailed engineering spec docs --
  implementation history (version corrections, React/CSS internals, DOM
  structure) is deliberately left out here since it's not relevant to
  reviewing a Figma frame; only what matters for visual/usage conformance is
  kept. See the team's own docs for full implementation detail.

  Unlike the old Figma-based reference, this file is NOT auto-updated --
  when the actual design system changes, someone needs to edit this file to
  match.
-->

## Foundations

- Base spacing unit is 16px. Label-to-content gap: 10px when label is positioned above (top), 16px when positioned to the left (with a 240px label column width).
- Corner radius scale: default 12px, large 28px, full = half the height (or width, for circular elements).
- Shadow scale: Low (dropdowns/tooltips), Medium (toasts), High (topmost layers/modals).
- Typography: Noto Sans JP.
  - Heading (Medium weight only): 2xl 27/32px, xl 22/28px, lg 19/24px, md 16/22px, sm 14/20px, xs 12/18px. Single-line, truncates with ellipsis -- never wraps to multiple lines.
  - Body (Regular or Bold): lg 16/22px, md 14/20px, sm 12/18px, xs 11/15px. Wraps to multiple lines (unlike Heading).
  - Number display ("stat", for emphasized numbers/percentages only): SF Pro Rounded, lg 27/32px, md 22/28px. No bold variant.
  - Flag any custom font, size, or line-height not on this scale, and any Heading text that wraps instead of truncating.

## Icon

- Sizes: sm 16px / md 20px / lg 24px / xl 28px.
- Weights: fill / bold / regular.
- Color tokens: `color/foreground/default` or `color/button/primary/default` depending on context.
- Naming is kebab-case: `Icons (Android/Desktop) - icon-name - shape/feature - position/state`. Flag icon layers with unclear or non-descriptive names.

## Button

- Types: Filled, Outlined, Ghost, Text, Inner (5 kinds, 6 variants total).
- Font: `typography/body/md/regular` for all button labels -- flag any button using a different type scale or a hardcoded font size.
- Icon-mark position: before text, after text, icon-only (requires an accessible label), or text-only.
- Only one primary/filled button should be the clear main action per screen -- flag multiple competing primary buttons (see also written guidelines).
- Destructive/dangerous actions must use a danger variant, never the default/primary variant.

## Inner button (small icon-only buttons used inside other components)

- Two sizes: sm 24x24px (12px corner radius) and md 32x32px (16px corner radius) -- i.e. always `radius = half the height`.
- Used consistently as the toggle/action control inside Accordion (32x32px), Select field's caret (24x24px), Number field's stepper, Search input's icon buttons, and Table's row actions -- flag a custom-built icon button standing in for this where one of these patterns applies.

## Text field

- Structure: Label (optional) / input / description (optional) / error message (error state only).
- States: default / disabled / readonly / error.
- Label position: top (10px gap) or left (16px gap + 240px label column).
- Description text color: `color/foreground/muted`. Placeholder text: `color/foreground/subtle`. Actual input text: `color/foreground/default`. Error message: `color/foreground/danger`.
- No stepper (increment/decrement) -- that's what distinguishes it from Number field.

## Textarea field

- Same label/description/error pattern as Text field, plus a resize handle and (when content exceeds ~3 lines) a scrollbar.
- Default height fits 3 lines.

## Number field

- Structure: Label / input with a two-button vertical stepper (up/down) attached to the right edge, flush with no gap.
- Stepper buttons: 32px wide each, height matches the input's actual height. Up icon and down icon are two distinct icons (not one icon rotated 180°).
- Field width is NOT fixed -- it should expand to fit content; flag a hardcoded/fixed width.

## Password field

- Same label/layout pattern as Text field, plus a 32x32px eye / eye-slash toggle button on the right showing the field's current masked/visible state (eye icon = currently masked, eye-slash = currently visible text).
- Field width adapts to content, not fixed.

## Date field

- Structure: Label / date input / calendar icon button / error message (optional).
- Two content formats: "day" (`YYYY/MM/DD`) or "minute" (`YYYY/MM/DD hh:mm`).
- Recommended widths: 240px / 496px / 752px -- flag arbitrary widths outside this set.
- States: default, readonly (uses `color/surface/transparent-tint` background), error, disabled (50% opacity).

## Search input

- Border: 1px `color/border/normal`. Prefix is a magnifying-glass icon rendered as a real inner button (not decorative), suffix is a 20x20px clear (x-circle) button that only appears once text is entered.
- Two sizes: md (40px tall, 32px inner button) and sm (32px tall, 24px inner button) -- but the clear button stays 24px in both sizes.
- Radius: default 12px, or "full" (20px md / 16px sm, following radius = half height).

## Select field / Dropdown

- Structure: Label / trigger (shows placeholder, selected value, or selected chips) / dropdown list.
- Trigger's caret-down icon uses inner-button size **sm** (24x24px) intentionally -- the team decided not to make this arrow too prominent. The same sm-size pattern is shared with Accordion's toggle... actually Accordion's toggle is 32px (md) -- don't conflate the two; check each component's own spec above.
- List items: checkmark on the selected item (single-select) or checkbox (multi-select), optional avatar (32x32px circle), optional muted-color description text, optional bold group-heading row.
- Multi-select selections render as 24px-tall chips with an inner close button; supports an "All"/select-all option.
- Item width is NOT fixed -- items fill the dropdown's available width (dropdown itself is a fixed 320px).
- Description text color is `color/foreground/muted` (consistent with every other component's description text).

## Checkbox

- checkbox-mark: 16x16px visible box inside a 2px padding wrapper = 20x20px hit target. Corner radius 4px.
- States: checked / unchecked / indeterminate, each combinable with error and disabled.
- checkbox-with-label: default width 240px, label can be positioned left or right of the mark, optional description text.
- checkbox-group: options laid out "top" (label above choices) or "left" (label beside choices).
- Checked+error state uses the danger button color token.

## Radio button

- Mark: 16x16px visible circle inside 2px padding = 20x20px hit target -- mirrors Checkbox's structure exactly.
- Unselected: `color/border/normal`, or `color/border/danger` in an error group. Selected: `color/border/accent` (or danger, in an error group) with a matching center dot.
- Disabled: 50% opacity regardless of selection.
- Groups: top-label layout (`flex-col`, 10px gaps) or left-label layout (`flex-row`, 16px gaps, 240px label width).

## Switch

- External frame 44x40px, visible track 44x24px, corner radius 20px (full/pill).
- Label position left requires a fixed 240px label column (not variable width).
- Disabled state: off-track and label are NOT dimmed; only the on-state track gets 50% opacity -- don't apply a uniform disabled dimming to the whole switch.

## Segmented Control

- Two sizes: sm 32px / md 40px tall. Maximum 6 items.
- States: selected / default / disabled.
- Selection is shown via a single sliding highlighted "thumb," not per-button background toggling -- flag an implementation/mock where each button independently toggles its own background instead of one shared indicator.
- Selected/unselected padding must be visually identical (16px) so text doesn't shift position when selection changes.
- Disabled applies 50% opacity to the whole control.
- This is for switching between views on the same screen -- not a substitute for Tabs (page/section navigation) or for actual navigation.

## Tab

- Two sizes: md 40px tall (16px horizontal padding) / sm 32px tall (12px padding). Icons (when present) are 20x20px.
- States: default / disabled / selected. Selected state is shown ONLY via a 2px accent-colored underline -- font weight stays the same across all states (don't bold the selected tab's text).
- Default/disabled tabs show a thin 1px neutral-colored underline instead.
- Content variants: text only, icon+text, or icon-only (icon-only requires an accessible label).
- Disabled: 50% opacity applied to the whole tab item including its underline.

## Tag

- Fixed 22px height, corner radius 11px (= half height). Non-interactive except when paired with a close button.
- Padding: 8px left / 0px right when a close button is present (the close button itself provides the right-side spacing); 2px gap between label and close button.
- Colors: semantic state colors (upcoming/active/delayed/completed have fixed meaning) plus freely-assignable classification colors (blue/purple/teal).
- Text should be short (1-4 characters is typical); longer text truncates with an ellipsis rather than growing the tag.
- Don't use a Tag as a substitute for a Button or Link (e.g. for navigation), and don't use it for multi-select (use Checkboxes or a proper multi-select component instead).
- Note: multi-select "chip" elements inside Select field are a separate, visually different element from Tag -- don't conflate the two.

## Avatar

- Circular, with a 0.8px `color/border/soft` inner border.
- Three sizes (sm 24px / md 32px / lg 40px) x three types (icon / letter / image). Corner radius always = half the height for each size.
- Type "letter": single initial character, white text, on `color/button/primary/default` background.
- Type "icon": a user glyph centered on a light tinted background.
- Type "image": the photo fully fills the circle (no visible background).

## Callout

- Four types: info, danger, success, warning -- each with its own fixed border/background/icon color combination (don't mix, e.g., a danger-colored border with a success icon).
- Fixed 20x20px icon, 8px padding, 8px icon-to-content gap, 12px corner radius.
- Use for embedded, in-context information (e.g. field requirements, system state) -- not for urgent/blocking notifications (that's what Toast is for), and prefer a field's own inline error message over a Callout for single-field validation.
- Only one Callout of the same type per area is recommended.

## Toast

- Fixed 320px width. Title: 14px bold. Optional description: 12px regular, 2px below the title. Close button 24x24px (12px corner radius).
- Four types: info, error, success, loading -- each with its own icon and feedback-status color token.
- Used for temporary, global, non-blocking feedback about an action (e.g. save/submit confirmation) -- not for content requiring sustained reading or a decision that blocks further action.

## Tooltip

- Card container, 12px horizontal / 8px vertical padding, 8px internal gap, 12px corner radius.
- Max width 240px (outer), 216px (inner text area). Body/medium text.
- Four placements (up/down/left/right). Covers only the visual card -- the actual show/hide trigger (hover/focus) is a separate behavioral concern, not something to check visually.

## Accordion

- Structure: header (title + optional description + toggle icon) / body (collapsible content area).
- Fixed 360px width. No nesting -- an Accordion inside an Accordion is not supported.
- Toggle button: 32x32px inner button (16px icon inside), using a single caret-down icon rotated 180° when expanded (not two separate icons).
- Header title: `color/foreground/default`. Description: `color/foreground/muted`.
- Only the toggle icon itself is clickable -- the header's hover highlight can cover the whole header, but the click target is just the icon button.

## Table

- Outer wrapper: 1px `color/border/normal` border, 28px corner radius ("large" radius), no outer padding, content clipped to the rounded corners.
- Row types: heading (36px tall) and content (48px tall). Row border, when enabled, is a top border (not bottom) so it applies uniformly including the boundary right after the heading row.
- Cell padding: 16px horizontal on the row, 8px horizontal / 4px vertical per cell, with cells that hold multiple elements (e.g. icon+text) wrapping with a 4px gap between them.
- Checkbox column (when present) must reuse the exact same checkbox visual as the standalone Checkbox component -- flag a custom-built checkbox mark in a table that doesn't match.
- Action-column buttons use the 32x32px inner-button pattern (radius = half height), same as elsewhere in the system.
- Column widths are NOT fixed/preset -- columns without an explicit width share remaining space equally.

## Dialog

<!-- No detailed spec provided yet -- fill in when available. -->
