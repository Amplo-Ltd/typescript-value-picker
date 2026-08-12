import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';

type ValueKind = 'literal' | 'enum';

type ValueChoice = {
  label: string;
  sourceText: string;
};

type ValueAnchor = {
  kind: ValueKind;
  line: number;
  prefix: string;
  suffix: string;
  originalText: string;
};

type ValueTarget = {
  range: vscode.Range;
  anchor: ValueAnchor;
  targetName: string;
  choices: ValueChoice[];
  hoverMessage?: vscode.MarkdownString;
};

type PositionMode = 'link' | 'inline' | 'above';

type DecorationState = {
  version: number;
  mode: PositionMode;
  signature?: string;
};

type LineRange = {
  startLine: number;
  endLine: number;
};

function getPositionMode(): PositionMode {
  const value = vscode.workspace
    .getConfiguration('typescriptValuePicker')
    .get<string>('positionMode', 'inline');

  return value === 'link' || value === 'above' ? value : 'inline';
}

const literalSourcePattern = /^(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|-?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:n)?|true|false|null|undefined)$/;
const enumMemberSourcePattern = /^(?:[$A-Z_a-z][$\w]*\s*\.\s*)+[$A-Z_a-z][$\w]*(?:\s*\[\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|-?\d+)\s*\])?$/;

function isValueSource(text: string, kind: ValueKind): boolean {
  return kind === 'enum'
    ? enumMemberSourcePattern.test(text)
    : literalSourcePattern.test(text);
}

function toLineRange(range: vscode.Range): LineRange {
  return {
    startLine: range.start.line,
    endLine: range.end.line
  };
}

function containsLineRange(outer: LineRange | undefined, inner: vscode.Range): boolean {
  return !outer || (
    outer.startLine <= inner.start.line &&
    outer.endLine >= inner.end.line
  );
}

function getDecorationSignature(targets: ValueTarget[]): string {
  return JSON.stringify(targets.map(target => ({
    range: [
      target.range.start.line,
      target.range.start.character,
      target.range.end.line,
      target.range.end.character
    ],
    anchor: [
      target.anchor.line,
      target.anchor.prefix,
      target.anchor.suffix,
      target.anchor.originalText
    ],
    targetName: target.targetName,
    choices: target.choices.map(choice => [choice.label, choice.sourceText])
  })));
}

function resolveValueRange(
  document: vscode.TextDocument,
  anchor: ValueAnchor
): vscode.Range | undefined {
  const lineNumber = Math.min(anchor.line, document.lineCount - 1);
  const line = document.lineAt(lineNumber).text;
  let match: vscode.Range | undefined;
  let prefixStart = line.indexOf(anchor.prefix);

  while (prefixStart >= 0) {
    const valueStart = prefixStart + anchor.prefix.length;
    const suffixStart = anchor.suffix.length === 0
      ? line.length
      : line.indexOf(anchor.suffix, valueStart);

    if (suffixStart >= valueStart) {
      const currentText = line.slice(valueStart, suffixStart);

      if (isValueSource(currentText, anchor.kind)) {
        if (match) {
          return undefined;
        }

        match = new vscode.Range(
          lineNumber,
          valueStart,
          lineNumber,
          suffixStart
        );
      }
    }

    prefixStart = line.indexOf(anchor.prefix, prefixStart + 1);
  }

  return match;
}

const supportedLanguageIds = new Set([
  'typescript',
  'typescriptreact'
]);
const documentRegistry = ts.createDocumentRegistry();

function findConfigPaths(fileName: string): string[] {
  const directory = path.dirname(fileName);
  const configPaths = [
    ts.findConfigFile(directory, ts.sys.fileExists, 'tsconfig.app.json'),
    ts.findConfigFile(directory, ts.sys.fileExists, 'tsconfig.json')
  ].filter((configPath): configPath is string => !!configPath);

  return configPaths.filter(
    (configPath, index) => configPaths.indexOf(configPath) === index
  );
}

function sameFile(left: string, right: string): boolean {
  return fileKey(left) === fileKey(right);
}

function fileKey(fileName: string): string {
  return path.normalize(fileName).toLowerCase();
}

interface LanguageServiceState {
  rootNames: string[];
  rootNameSet: Set<string>;
  openFiles: Map<string, string>;
  openVersions: Map<string, number>;
}

interface ProjectLanguageServiceCache {
  service: ts.LanguageService;
  state: LanguageServiceState;
}

function readProjectConfig(configPath: string): ts.ParsedCommandLine | undefined {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);

  if (config.error) {
    return undefined;
  }

  return ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath
  );
}

function syncOpenFile(
  state: LanguageServiceState,
  document: vscode.TextDocument,
  text?: string
): void {
  const documentKey = fileKey(document.fileName);

  if (state.openVersions.get(documentKey) === document.version) {
    return;
  }

  state.openFiles.set(documentKey, text === undefined ? document.getText() : text);
  state.openVersions.set(documentKey, document.version);
}

function syncOpenFiles(
  state: LanguageServiceState,
  document: vscode.TextDocument
): void {
  vscode.workspace.textDocuments.forEach(openDocument => {
    syncOpenFile(state, openDocument);
  });

  syncOpenFile(state, document);
}

function forgetOpenFile(
  state: LanguageServiceState,
  document: vscode.TextDocument
): void {
  const documentKey = fileKey(document.fileName);
  state.openFiles.delete(documentKey);
  state.openVersions.delete(documentKey);
}

function createLanguageService(
  document: vscode.TextDocument,
  configPath: string,
  parsed: ts.ParsedCommandLine,
  previous: ProjectLanguageServiceCache | undefined
): ProjectLanguageServiceCache {
  if (previous) {
    const documentKey = fileKey(document.fileName);

    if (!previous.state.rootNameSet.has(documentKey)) {
      previous.state.rootNames.push(document.fileName);
      previous.state.rootNameSet.add(documentKey);
    }

    syncOpenFile(previous.state, document);
    return previous;
  }

  const state: LanguageServiceState = {
    rootNames: parsed.fileNames.slice(),
    rootNameSet: new Set(parsed.fileNames.map(fileName => fileKey(fileName))),
    openFiles: new Map<string, string>(),
    openVersions: new Map<string, number>()
  };

  const documentKey = fileKey(document.fileName);

  if (!state.rootNameSet.has(documentKey)) {
    state.rootNames.push(document.fileName);
    state.rootNameSet.add(documentKey);
  }

  syncOpenFiles(state, document);

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => state.rootNames,
    getScriptVersion: fileName => {
      const key = fileKey(fileName);
      const openVersion = state.openVersions.get(key);

      if (openVersion !== undefined) {
        return String(openVersion);
      }

      const modifiedTime = ts.sys.getModifiedTime
        ? ts.sys.getModifiedTime(fileName)
        : undefined;
      return modifiedTime ? String(modifiedTime.getTime()) : '0';
    },
    getScriptSnapshot: fileName => {
      const key = fileKey(fileName);
      const openText = state.openFiles.get(key);
      const text = openText !== undefined ? openText : ts.sys.readFile(fileName);

      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => path.dirname(configPath),
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    fileExists: fileName => state.openFiles.has(fileKey(fileName)) ||
      ts.sys.fileExists(fileName),
    readFile: fileName => {
      const key = fileKey(fileName);
      const openText = state.openFiles.get(key);
      return openText !== undefined ? openText : ts.sys.readFile(fileName);
    },
    readDirectory: ts.sys.readDirectory
  };

  return {
    state,
    service: ts.createLanguageService(host, documentRegistry)
  };
}

function getLiteralChoice(
  type: ts.Type,
  checker: ts.TypeChecker
): ValueChoice | undefined {
  if (type.flags & ts.TypeFlags.StringLiteral) {
    const value = (type as ts.StringLiteralType).value;

    return {
      label: value,
      sourceText: JSON.stringify(value)
    };
  }

  if (type.flags & ts.TypeFlags.NumberLiteral) {
    const value = (type as ts.NumberLiteralType).value;

    return {
      label: String(value),
      sourceText: String(value)
    };
  }

  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    const value = checker.typeToString(type);

    return {
      label: value,
      sourceText: value
    };
  }

  if (type.flags & ts.TypeFlags.Null) {
    return {
      label: 'null',
      sourceText: 'null'
    };
  }

  if (type.flags & ts.TypeFlags.Undefined) {
    return {
      label: 'undefined',
      sourceText: 'undefined'
    };
  }

  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    const value = checker.typeToString(type);

    return {
      label: value,
      sourceText: value
    };
  }

  return undefined;
}

function getLiteralChoices(
  checker: ts.TypeChecker,
  node: ts.Expression
): ValueChoice[] {
  const contextualType = checker.getContextualType(node);

  if (contextualType && !contextualType.isUnion()) {
    return [];
  }

  const type = contextualType || checker.getTypeAtLocation(node);
  const members = type.isUnion() ? type.types : [type];

  if (members.length < 2) {
    return [];
  }

  const choices = members.map(member => getLiteralChoice(member, checker));

  if (choices.some(choice => !choice)) {
    return [];
  }

  return choices as ValueChoice[];
}

function isLiteralCandidate(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return true;
  }

  if (ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.operand)) {
    return true;
  }

  if (ts.isIdentifier(node) && node.text === 'undefined') {
    return true;
  }

  return node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.BigIntLiteral;
}

type EnumValueAccess = {
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression;
  member: ts.EnumMember;
};

function getEnumMemberFromSymbol(symbol: ts.Symbol | undefined): ts.EnumMember | undefined {
  const declaration = symbol && symbol.valueDeclaration;

  return declaration && ts.isEnumMember(declaration) ? declaration : undefined;
}

function getEnumValueAccess(
  checker: ts.TypeChecker,
  node: ts.Node
): EnumValueAccess | undefined {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) {
    return undefined;
  }

  const memberNode = ts.isPropertyAccessExpression(node)
    ? node.name
    : node.argumentExpression;

  if (!memberNode) {
    return undefined;
  }

  const member = getEnumMemberFromSymbol(
    checker.getSymbolAtLocation(memberNode) || checker.getSymbolAtLocation(node)
  );

  return member ? { node, member } : undefined;
}

function getEnumMemberName(member: ts.EnumMember): string | undefined {
  if (ts.isIdentifier(member.name) ||
      ts.isStringLiteral(member.name) ||
      ts.isNumericLiteral(member.name)) {
    return member.name.text;
  }

  return undefined;
}

function getEnumMemberSourceText(
  access: EnumValueAccess,
  member: ts.EnumMember,
  sourceFile: ts.SourceFile
): string | undefined {
  const memberName = getEnumMemberName(member);

  if (memberName === undefined) {
    return undefined;
  }

  const enumExpressionText = access.node.expression.getText(sourceFile);

  if (ts.isPropertyAccessExpression(access.node) && ts.isIdentifier(member.name)) {
    return `${enumExpressionText}.${memberName}`;
  }

  const memberKey = ts.isNumericLiteral(member.name)
    ? memberName
    : JSON.stringify(memberName);

  return `${enumExpressionText}[${memberKey}]`;
}

function getEnumChoices(
  access: EnumValueAccess,
  sourceFile: ts.SourceFile
): ValueChoice[] {
  const choices: ValueChoice[] = [];

  for (const member of access.member.parent.members) {
    const memberName = getEnumMemberName(member);
    const sourceText = getEnumMemberSourceText(access, member, sourceFile);

    if (memberName === undefined || sourceText === undefined) {
      return [];
    }

    choices.push({
      label: memberName,
      sourceText
    });
  }

  return choices.length >= 2 ? choices : [];
}

type ValueAnalysis = {
  kind: ValueKind;
  choices: ValueChoice[];
};

function getValueAnalysis(
  checker: ts.TypeChecker,
  node: ts.Node,
  sourceFile: ts.SourceFile
): ValueAnalysis | undefined {
  if (isLiteralCandidate(node)) {
    const choices = getLiteralChoices(checker, node as ts.Expression);

    return choices.length > 0
      ? { kind: 'literal', choices }
      : undefined;
  }

  const enumAccess = getEnumValueAccess(checker, node);

  if (!enumAccess) {
    return undefined;
  }

  const choices = getEnumChoices(enumAccess, sourceFile);

  return choices.length > 0
    ? { kind: 'enum', choices }
    : undefined;
}

function getTargetName(node: ts.Node, sourceFile: ts.SourceFile): string {
  let parent = node.parent;

  while (parent && (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isTypeAssertion(parent)
  )) {
    parent = parent.parent;
  }

  if (parent && ts.isPropertyAssignment(parent)) {
    return parent.name.getText(sourceFile);
  }

  if (parent && ts.isVariableDeclaration(parent)) {
    return parent.name.getText(sourceFile);
  }

  if (parent && ts.isPropertyDeclaration(parent)) {
    return parent.name.getText(sourceFile);
  }

  if (parent && ts.isPropertySignature(parent)) {
    return parent.name.getText(sourceFile);
  }

  if (parent && ts.isParameter(parent)) {
    return parent.name.getText(sourceFile);
  }

  if (parent && ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return parent.left.getText(sourceFile);
  }

  return 'this value';
}

function collectInlayHints(
  document: vscode.TextDocument,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  mode: PositionMode,
  lineRange?: LineRange
): { hints: vscode.InlayHint[]; targets: ValueTarget[] } {
  const hints: vscode.InlayHint[] = [];
  const targets: ValueTarget[] = [];

  function visit(node: ts.Node): void {
    if (lineRange) {
      const nodeStart = document.positionAt(node.getStart(sourceFile));
      const nodeEnd = document.positionAt(node.getEnd());

      if (nodeEnd.line < lineRange.startLine ||
          nodeStart.line > lineRange.endLine) {
        return;
      }
    }

    const analysis = getValueAnalysis(checker, node, sourceFile);

    if (analysis) {
      const start = document.positionAt(node.getStart(sourceFile));
      const end = document.positionAt(node.getEnd());

      if (start.line === end.line) {
        const line = document.lineAt(start.line);
        const lineText = line.text;
        const anchor: ValueAnchor = {
          kind: analysis.kind,
          line: start.line,
          prefix: lineText.slice(0, start.character),
          suffix: lineText.slice(end.character),
          originalText: lineText.slice(start.character, end.character)
        };
        const targetName = getTargetName(node, sourceFile);

        targets.push({
          range: new vscode.Range(start, end),
          anchor,
          targetName,
          choices: analysis.choices,
          hoverMessage: mode === 'inline'
            ? createPickerMarkdown(document.uri, anchor, targetName, analysis.choices)
            : undefined
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (mode === 'link') {
    const targetsByLine = new Map<number, ValueTarget[]>();

    targets.forEach(target => {
      const lineTargets = targetsByLine.get(target.range.start.line) || [];
      lineTargets.push(target);
      targetsByLine.set(target.range.start.line, lineTargets);
    });

    targetsByLine.forEach(lineTargets => {
      lineTargets.forEach(target => {
        const line = document.lineAt(target.range.start.line);
        const position = lineTargets.length === 1
          ? line.range.end
          : target.range.end;
        const hint = new vscode.InlayHint(
          position,
          [new vscode.InlayHintLabelPart('Change value')]
        );
        const label = hint.label as vscode.InlayHintLabelPart[];

        label[0].command = {
          title: 'Change value',
          command: 'typescriptValuePicker.change',
          arguments: [document.uri, target.anchor, target.choices, target.targetName]
        };
        hint.paddingLeft = true;
        hint.tooltip = 'Change value';
        hints.push(hint);
      });
    });
  }

  return { hints, targets };
}

class ValuePickerPositionProvider implements
  vscode.InlayHintsProvider<vscode.InlayHint>,
  vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly configPathCache = new Map<string, string | undefined>();
  private readonly configCache = new Map<string, ts.ParsedCommandLine>();
  private readonly languageServiceCache = new Map<string, ProjectLanguageServiceCache>();
  private readonly lensCache = new Map<string, {
    version: number;
    lenses: vscode.InlayHint[];
    analyzedRange?: LineRange;
  }>();
  private readonly targetCache = new Map<string, { version: number; targets: ValueTarget[] }>();
  private readonly documentProjectCache = new Map<string, string>();
  private readonly decorationState = new WeakMap<vscode.TextEditor, DecorationState>();
  private positionMode: PositionMode = getPositionMode();
  private readonly inlineDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: ' Change value',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
      margin: '0 0 0 0.75em'
    }
  });
  private readonly targetHoverDecorationType = vscode.window.createTextEditorDecorationType({});
  private readonly analysisTimers = new Map<string, NodeJS.Timeout>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshPending = false;

  public readonly onDidChangeInlayHints = this.changeEmitter.event;
  public readonly onDidChangeCodeLenses = this.changeEmitter.event;

  public provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken
  ): vscode.InlayHint[] {
    if (token.isCancellationRequested || !supportedLanguageIds.has(document.languageId)) {
      return [];
    }

    const documentKey = document.uri.toString();
    const mode = this.positionMode;
    const cachedLenses = this.lensCache.get(documentKey);

    const cachedRangeIsValid = cachedLenses &&
      cachedLenses.version === document.version &&
      (mode !== 'link' || containsLineRange(cachedLenses.analyzedRange, range));

    if (cachedRangeIsValid && cachedLenses) {
      return mode === 'above' ? [] : cachedLenses.lenses;
    }

    // Defer first-time project initialization so opening a file does not block
    // the editor while TypeScript loads the project graph.
    if (this.refreshPending) {
      return cachedRangeIsValid && cachedLenses ? cachedLenses.lenses : [];
    }

    this.scheduleAnalysis(
      document,
      0,
      mode === 'link' ? toLineRange(range) : undefined
    );
    return cachedRangeIsValid && cachedLenses ? cachedLenses.lenses : [];
  }

  private scheduleAnalysis(
    document: vscode.TextDocument,
    delay = 0,
    requestedRange?: LineRange
  ): void {
    const documentKey = document.uri.toString();
    const existingTimer = this.analysisTimers.get(documentKey);

    if (existingTimer && delay === 0) {
      return;
    }

    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const version = document.version;
    const timer = setTimeout(() => {
      this.analysisTimers.delete(documentKey);

      const currentDocument = vscode.workspace.textDocuments.find(
        openDocument => openDocument.uri.toString() === documentKey
      );

      if (!currentDocument) {
        return;
      }

      if (currentDocument.version !== version) {
        this.scheduleAnalysis(currentDocument, delay, requestedRange);
        return;
      }

      this.analyzeDocument(currentDocument, requestedRange);
      this.refreshVisibleDecorations();
      this.changeEmitter.fire();
    }, delay);

    this.analysisTimers.set(documentKey, timer);
  }

  private analyzeDocument(document: vscode.TextDocument, requestedRange?: LineRange): void {
    const documentKey = document.uri.toString();
    const mode = this.positionMode;

    const configPath = this.getConfigPath(document.fileName);

    if (!configPath) {
      this.documentProjectCache.delete(documentKey);
      this.lensCache.set(documentKey, {
        version: document.version,
        lenses: [],
        analyzedRange: requestedRange
      });
      this.targetCache.set(documentKey, { version: document.version, targets: [] });
      return;
    }

    let parsed = this.configCache.get(configPath);

    if (!parsed) {
      parsed = readProjectConfig(configPath);

      if (!parsed) {
        this.documentProjectCache.delete(documentKey);
        this.lensCache.set(documentKey, {
          version: document.version,
          lenses: [],
          analyzedRange: requestedRange
        });
        this.targetCache.set(documentKey, { version: document.version, targets: [] });
        return;
      }

      this.configCache.set(configPath, parsed);
    }

    this.documentProjectCache.set(documentKey, configPath);

    let project = this.languageServiceCache.get(configPath);

    if (!project ||
        !project.state.rootNameSet.has(fileKey(document.fileName))) {
      project = createLanguageService(document, configPath, parsed, project);
      this.languageServiceCache.set(configPath, project);
    }

    syncOpenFile(project.state, document);

    const program = project.service.getProgram();

    if (!program) {
      this.lensCache.set(documentKey, {
        version: document.version,
        lenses: [],
        analyzedRange: requestedRange
      });
      this.targetCache.set(documentKey, { version: document.version, targets: [] });
      return;
    }

    const sourceFile = program.getSourceFile(document.fileName) ||
      program.getSourceFiles().find(
        file => sameFile(file.fileName, document.fileName)
      );

    if (!sourceFile) {
      this.lensCache.set(documentKey, {
        version: document.version,
        lenses: [],
        analyzedRange: requestedRange
      });
      this.targetCache.set(documentKey, { version: document.version, targets: [] });
      return;
    }

    const result = collectInlayHints(
      document,
      sourceFile,
      program.getTypeChecker(),
      mode,
      mode === 'link' ? requestedRange : undefined
    );

    this.lensCache.set(documentKey, {
      version: document.version,
      lenses: result.hints,
      analyzedRange: requestedRange
    });
    this.targetCache.set(documentKey, { version: document.version, targets: result.targets });
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    if (token.isCancellationRequested ||
        !supportedLanguageIds.has(document.languageId) ||
        this.positionMode !== 'above') {
      return [];
    }

    this.provideInlayHints(
      document,
      new vscode.Range(0, 0, document.lineCount, 0),
      token
    );

    const cached = this.targetCache.get(document.uri.toString());

    if (!cached || cached.version !== document.version) {
      return [];
    }

    return cached.targets.map(target => new vscode.CodeLens(
      target.range,
      {
        title: 'Change value',
        command: 'typescriptValuePicker.change',
        arguments: [document.uri, target.anchor, target.choices, target.targetName]
      }
    ));
  }

  private getConfigPath(fileName: string): string | undefined {
    const normalizedFileKey = fileKey(fileName);

    if (this.configPathCache.has(normalizedFileKey)) {
      return this.configPathCache.get(normalizedFileKey);
    }

    const configPath = findConfigPaths(fileName)[0];
    this.configPathCache.set(normalizedFileKey, configPath);
    return configPath;
  }

  public scheduleRefresh(): void {
    this.positionMode = getPositionMode();
    this.refreshPending = true;
    this.clearInlineDecorations();
    this.analysisTimers.forEach(timer => clearTimeout(timer));
    this.analysisTimers.clear();

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshPending = false;
      this.clearResultCaches();
      this.clearInlineDecorations();
      this.changeEmitter.fire();
    }, 250);
  }

  public invalidateProjects(): void {
    this.analysisTimers.forEach(timer => clearTimeout(timer));
    this.analysisTimers.clear();
    this.configPathCache.clear();
    this.configCache.clear();
    this.languageServiceCache.forEach(project => project.service.dispose());
    this.languageServiceCache.clear();
    this.clearResultCaches();
    this.clearInlineDecorations();
  }

  private clearResultCaches(): void {
    this.lensCache.clear();
    this.targetCache.clear();
    this.documentProjectCache.clear();
  }

  public scheduleDocumentRefresh(document: vscode.TextDocument): void {
    const documentKey = document.uri.toString();
    const projectPath = this.documentProjectCache.get(documentKey) ||
      this.getConfigPath(document.fileName);

    if (projectPath) {
      this.documentProjectCache.forEach((cachedProjectPath, cachedDocumentKey) => {
        if (cachedProjectPath === projectPath) {
          this.lensCache.delete(cachedDocumentKey);
          this.targetCache.delete(cachedDocumentKey);
        }
      });
    } else {
      this.lensCache.delete(documentKey);
      this.targetCache.delete(documentKey);
    }

    this.scheduleAnalysis(document, 250, this.getVisibleLineRange(document));
  }

  private getVisibleLineRange(document: vscode.TextDocument): LineRange | undefined {
    let startLine = Number.MAX_SAFE_INTEGER;
    let endLine = -1;

    vscode.window.visibleTextEditors.forEach(editor => {
      if (editor.document.uri.toString() !== document.uri.toString()) {
        return;
      }

      editor.visibleRanges.forEach(range => {
        startLine = Math.min(startLine, range.start.line);
        endLine = Math.max(endLine, range.end.line);
      });
    });

    return endLine >= 0 ? { startLine, endLine } : undefined;
  }

  public syncOpenDocument(document: vscode.TextDocument): void {
    const text = document.getText();

    this.languageServiceCache.forEach(project => {
      syncOpenFile(project.state, document, text);
    });
  }

  public refreshVisibleDecorations(): void {
    const mode = this.positionMode;

    vscode.window.visibleTextEditors.forEach(editor => {
      if (!supportedLanguageIds.has(editor.document.languageId)) {
        return;
      }

      const cached = this.targetCache.get(editor.document.uri.toString());
      const currentState = this.decorationState.get(editor);

      if (mode !== 'inline') {
        if (!currentState || currentState.mode === 'inline') {
          editor.setDecorations(this.inlineDecorationType, []);
          editor.setDecorations(this.targetHoverDecorationType, []);
        }

        this.decorationState.set(editor, { version: editor.document.version, mode });
        return;
      }

      if (!cached || cached.version !== editor.document.version) {
        return;
      }

      const signature = getDecorationSignature(cached.targets);

      if (currentState &&
          currentState.mode === mode &&
          currentState.signature === signature) {
        this.decorationState.set(editor, { version: cached.version, mode, signature });
        return;
      }

      const targetsByLine = new Map<number, ValueTarget[]>();

      cached.targets.forEach(target => {
        const lineTargets = targetsByLine.get(target.range.start.line) || [];
        lineTargets.push(target);
        targetsByLine.set(target.range.start.line, lineTargets);
      });

      const lineEndDecorations: vscode.DecorationOptions[] = [];
      const targetHoverDecorations: vscode.DecorationOptions[] = [];

      targetsByLine.forEach(lineTargets => {
        const target = lineTargets[0];
        const line = editor.document.lineAt(target.range.start.line);
        const lineEnd = line.range.end;
        const decorationRange = lineEnd.character > 0
          ? new vscode.Range(
            lineEnd.line,
            lineEnd.character - 1,
            lineEnd.line,
            lineEnd.character
          )
          : new vscode.Range(lineEnd, lineEnd);

        lineEndDecorations.push({
          range: decorationRange
        });

        lineTargets.forEach(lineTarget => {
          targetHoverDecorations.push({
            range: lineTarget.range,
            hoverMessage: lineTarget.hoverMessage
          });
        });
      });

      editor.setDecorations(this.inlineDecorationType, lineEndDecorations);
      editor.setDecorations(this.targetHoverDecorationType, targetHoverDecorations);
      this.decorationState.set(editor, { version: cached.version, mode, signature });
    });
  }

  private clearInlineDecorations(): void {
    vscode.window.visibleTextEditors.forEach(editor => {
      editor.setDecorations(this.inlineDecorationType, []);
      editor.setDecorations(this.targetHoverDecorationType, []);
      this.decorationState.delete(editor);
    });
  }

  public forgetDocument(document: vscode.TextDocument): void {
    const documentKey = document.uri.toString();
    const projectPath = this.documentProjectCache.get(documentKey) ||
      this.getConfigPath(document.fileName);
    const timer = this.analysisTimers.get(documentKey);

    if (timer) {
      clearTimeout(timer);
      this.analysisTimers.delete(documentKey);
    }

    this.lensCache.delete(documentKey);
    this.targetCache.delete(documentKey);
    this.documentProjectCache.delete(documentKey);
    this.configPathCache.delete(fileKey(document.fileName));
    this.languageServiceCache.forEach(project => {
      forgetOpenFile(project.state, document);
    });

    if (projectPath) {
      let projectStillUsed = false;

      this.documentProjectCache.forEach(cachedProjectPath => {
        if (cachedProjectPath === projectPath) {
          projectStillUsed = true;
        }
      });

      if (!projectStillUsed) {
        const project = this.languageServiceCache.get(projectPath);

        if (project) {
          project.service.dispose();
          this.languageServiceCache.delete(projectPath);
        }

        this.configCache.delete(projectPath);
      }
    }
  }

  public dispose(): void {
    this.analysisTimers.forEach(timer => clearTimeout(timer));
    this.analysisTimers.clear();

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.languageServiceCache.forEach(project => project.service.dispose());
    this.inlineDecorationType.dispose();
    this.targetHoverDecorationType.dispose();
    this.changeEmitter.dispose();
  }
}

const markdownEscapePattern = /([\\`*_[\]{}()#+.!|>])/g;

function escapeMarkdown(value: string): string {
  return value.replace(markdownEscapePattern, '\\$1');
}

function createPickerMarkdown(
  uri: vscode.Uri,
  anchor: ValueAnchor,
  targetName: string,
  choices: ValueChoice[]
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = true;
  markdown.appendMarkdown('### TypeScript Value Picker\n\n');
  const targetLabel = targetName && targetName !== 'this value'
    ? ` for \`${targetName.replace(/`/g, '\\`')}\``
    : '';
  markdown.appendMarkdown(`Select a value${targetLabel}:\n\n`);

  choices.forEach((choice, index) => {
    const commandArguments = encodeURIComponent(JSON.stringify([
      uri.toString(),
      anchor,
      choice.sourceText
    ]));

    markdown.appendMarkdown(
      `- [${escapeMarkdown(choice.label)}](command:typescriptValuePicker.apply?${commandArguments})`
    );

    if (index < choices.length - 1) {
      markdown.appendMarkdown('  \n');
    }
  });

  return markdown;
}

class ValuePickerHoverProvider implements vscode.HoverProvider {
  private readonly pending = new Map<string, {
    range: vscode.Range;
    anchor: ValueAnchor;
    targetName: string;
    choices: ValueChoice[];
  }>();

  public open(
    uri: vscode.Uri,
    range: vscode.Range,
    anchor: ValueAnchor,
    targetName: string,
    choices: ValueChoice[]
  ): void {
    this.pending.set(uri.toString(), { range, anchor, targetName, choices });
  }

  public clear(uri: vscode.Uri): void {
    this.pending.delete(uri.toString());
  }

  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const request = this.pending.get(document.uri.toString());

    if (!request ||
        (!request.range.contains(position) &&
         !request.range.start.isEqual(position) &&
         !request.range.end.isEqual(position))) {
      return undefined;
    }

    // A command explicitly opens this hover once. Consume the request before
    // returning it so closing the popup cannot reopen it by hovering the old target.
    this.pending.delete(document.uri.toString());

    return new vscode.Hover(
      createPickerMarkdown(
        document.uri,
        request.anchor,
        request.targetName,
        request.choices
      ),
      request.range
    );
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ValuePickerPositionProvider();
  const hoverProvider = new ValuePickerHoverProvider();
  const languageSelectors = [
    { language: 'typescript', scheme: 'file' },
    { language: 'typescriptreact', scheme: 'file' }
  ];

  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(
      languageSelectors,
      provider
    ),
    vscode.languages.registerCodeLensProvider(
      languageSelectors,
      provider
    ),
    vscode.languages.registerHoverProvider(
      languageSelectors,
      hoverProvider
    ),
    vscode.commands.registerCommand(
      'typescriptValuePicker.change',
      async (
        uri: vscode.Uri,
        anchor: ValueAnchor,
        choices: ValueChoice[],
        targetName: string
      ) => {
        const activeEditor = vscode.window.activeTextEditor;
        const activeDocument = activeEditor &&
          activeEditor.document.uri.toString() === uri.toString()
          ? activeEditor.document
          : undefined;
        const document = activeDocument || await vscode.workspace.openTextDocument(uri);
        const range = resolveValueRange(document, anchor);

        if (!range) {
          void vscode.window.showWarningMessage(
            'TypeScript Value Picker could not safely locate the original value. No change was made.'
          );
          return;
        }

        const editor = activeEditor && activeEditor.document.uri.toString() === uri.toString()
          ? activeEditor
          : await vscode.window.showTextDocument(document);

        hoverProvider.open(uri, range, anchor, targetName || 'this value', choices);
        editor.selection = new vscode.Selection(range.start, range.start);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

        void vscode.commands.executeCommand('editor.action.showHover');
      }
    ),
    vscode.commands.registerCommand(
      'typescriptValuePicker.apply',
      async (
        uriText: string,
        anchor: ValueAnchor,
        sourceText: string
      ) => {
        const uri = vscode.Uri.parse(uriText);
        const document = await vscode.workspace.openTextDocument(uri);
        const range = resolveValueRange(document, anchor);

        if (!range) {
          void vscode.window.showWarningMessage(
            'TypeScript Value Picker could not safely locate the original value. No change was made.'
          );
          return;
        }

        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, range, sourceText);
        await vscode.workspace.applyEdit(edit);
        hoverProvider.clear(uri);
      }
    ),
    vscode.window.onDidChangeActiveTextEditor(() => {
      provider.refreshVisibleDecorations();
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges(() => {
      provider.refreshVisibleDecorations();
    }),
    vscode.workspace.onDidOpenTextDocument(document => {
      if (supportedLanguageIds.has(document.languageId)) {
        provider.syncOpenDocument(document);
      }
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (supportedLanguageIds.has(event.document.languageId)) {
        hoverProvider.clear(event.document.uri);
        provider.syncOpenDocument(event.document);
        provider.scheduleDocumentRefresh(event.document);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('typescriptValuePicker.positionMode')) {
        provider.scheduleRefresh();
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      hoverProvider.clear(document.uri);
      provider.forgetDocument(document);
    }),
    ...(() => {
      const watcher = vscode.workspace.createFileSystemWatcher('**/tsconfig*.json');
      const refresh = () => {
        provider.invalidateProjects();
        provider.scheduleRefresh();
      };

      watcher.onDidCreate(refresh, undefined, context.subscriptions);
      watcher.onDidChange(refresh, undefined, context.subscriptions);
      watcher.onDidDelete(refresh, undefined, context.subscriptions);
      return [watcher];
    })(),
    provider
  );
}

export function deactivate(): void {
  // Nothing to dispose here; subscriptions are owned by the extension context.
}
