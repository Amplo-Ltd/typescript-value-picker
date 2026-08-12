# TypeScript Value Picker

Quickly switch between finite TypeScript values directly in the editor.
TypeScript Value Picker provides lightweight controls for literal unions and
enum members while keeping the surrounding source code unchanged.

## Features

- Pick from string, number, boolean, `null`, `undefined`, and bigint unions.
- Pick from regular and `const enum` members.
- Handle multiple selectable values independently on the same line.
- Use safe, anchor-based replacements that refuse ambiguous edits.
- Choose between inline, link, and CodeLens presentation modes.

## Usage

Open a TypeScript or TSX file containing a finite union or enum value. The
available picker depends on the configured display mode.

```ts
type Environment = 'Production' | 'Staging' | 'Debug';
type RetryCount = 0 | 1 | 2;

const environment: Environment = 'Debug';
const retryCount: RetryCount = 1;

enum DeploymentEnvironment {
  Production,
  Staging,
  Debug
}

const deploymentEnvironment: DeploymentEnvironment = DeploymentEnvironment.Debug;
```

Multiple values on one line are handled independently. In inline mode, hover
the actual value you want to change:

```ts
this.status = user.isActive
  ? ActiveStatuses.Active
  : ActiveStatuses.Inactive;
```

## Display modes

Configure `typescriptValuePicker.positionMode` in VS Code settings:

- `inline` (default) - shows one visual `Change value` decoration per line.
  The actual value expression is the hover target.
- `link` - shows a clickable `Change value` inlay link. With one target it is
  placed at the end of the line; with multiple targets, each link is placed
  beside its target. VS Code may require a modifier-click for inlay links.
- `above` - shows a clickable CodeLens above each target.

## Supported values

Literal unions can contain string, number, boolean, `null`, `undefined`, and
bigint literal members. Enum member references are also supported, including
qualified references such as `RequestType.NewClientRegistration`.

Plain `string` and `number` types are ignored because they do not provide a
finite list of choices.

The TypeScript project must be resolvable through a `tsconfig.json` or
`tsconfig.app.json` file.

## Safe replacements

Before applying a selection, the extension validates the original value and
its surrounding source anchor. If the value cannot be located uniquely, no
edit is made and a warning is shown. This prevents a selection from changing
commas, neighboring values, or unrelated text.

## Installation

Search for **TypeScript Value Picker** in the VS Code Extensions view and
select **Install**.
