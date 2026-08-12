# TypeScript Value Picker

VS Code extension for TypeScript projects. It provides quick, safe value
selection without changing the surrounding application code.

It adds a `Change value` control for values
whose type has a finite set of choices. This includes literal unions and enum
members. The available choices are resolved from the TypeScript type checker.

## Display modes

The display mode can be changed with `typescriptValuePicker.positionMode`:

- `inline` (default) - shows one visual `Change value` decoration per line.
  The actual value expression is the hover target, so multiple values on the
  same line each open their own picker.
- `link` - shows a clickable `Change value` inlay link. With one target it is
  placed at the end of the line; with multiple targets, each link is placed
  beside its target. VS Code may require a modifier-click for inlay links.
- `above` - shows a clickable CodeLens above each target.

```ts
type Environment = 'Production' | 'Staging' | 'Debug';
type RetryCount = 0 | 1 | 2;
type Result = 'Success' | 'Failed' | null;

const environment: Environment = 'Debug';
const retryCount: RetryCount = 1;
const result: Result = null;

enum DeploymentEnvironment {
  Production,
  Staging,
  Debug
}

const deploymentEnvironment: DeploymentEnvironment = DeploymentEnvironment.Debug;
```

Multiple values on one line are handled independently:

```ts
this.status = user.isActive
  ? ActiveStatuses.Active
  : ActiveStatuses.Inactive;
```

## Supported values

Literal unions can contain string, number, boolean, `null`, `undefined`, and
bigint literal members. Regular and `const enum` member references are also
supported, including qualified references such as
`RequestType.NewClientRegistration`.

Plain `string` and `number` types are intentionally ignored because they do
not provide a finite list of safe choices.

## Safe replacement behavior

The extension stores a small anchor around the original value and validates
the current source before applying a replacement. If the original value cannot
be located uniquely, it refuses to edit and shows a warning instead of risking
changes to surrounding code.

## Requirements

- A TypeScript or TSX file.
- A discoverable `tsconfig.json` or `tsconfig.app.json` in the workspace.
- A finite union or enum type that the TypeScript project can resolve.

## Installation

Install `TypeScript Value Picker` from the VS Code Extensions view after it is
published to the Marketplace.
