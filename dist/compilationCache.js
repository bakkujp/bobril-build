"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ts = require("typescript");
const fs = require("fs");
const pathPlatformDependent = require("path");
const path = pathPlatformDependent.posix; // This works everywhere, just use forward slashes
const imageOps = require("./imageOps");
const imgCache = require("./imgCache");
require('bluebird');
const BuildHelpers = require("./buildHelpers");
const bobrilDepsHelpers = require("./bobrilDepsHelpers");
const pathUtils = require("./pathUtils");
const bundler = require("./bundler");
const sourceMap = require("./sourceMap");
const dynamicBuffer_1 = require("./dynamicBuffer");
const simpleHelpers = require("./simpleHelpers");
const cssHelpers = require("./cssHelpers");
const shortenFileName_1 = require("./shortenFileName");
const plugins = require("./pluginsLoader");
function defaultLibs() {
    return [
        "es5",
        "dom",
        "es2015.core",
        "es2015.promise"
    ];
}
exports.defaultLibs = defaultLibs;
function addLibPrefixPostfix(names) {
    for (var i = 0; i < names.length; i++) {
        if (names[i].startsWith("lib."))
            continue;
        names[i] = "lib." + names[i] + ".d.ts";
    }
}
function isCssByExt(name) {
    return /\.css$/ig.test(name);
}
function isJsByExt(name) {
    return /\.js$/ig.test(name);
}
class CompilationResult {
    constructor() {
        this.errors = 0;
        this.warnings = 0;
        this.messages = [];
    }
    clearFileName(fn) {
        for (let i = 0; i < this.messages.length; i++) {
            let m = this.messages[i];
            if (m.fileName === fn) {
                if (m.isError)
                    this.errors--;
                else
                    this.warnings--;
                this.messages.splice(i, 1);
                i--;
            }
        }
    }
    addMessage(isError, fn, text, pos) {
        if (isError)
            this.errors++;
        else
            this.warnings++;
        this.messages.push({ fileName: fn, isError, text, pos });
    }
}
exports.CompilationResult = CompilationResult;
class CompilationCache {
    constructor() {
        this.defaultLibFilename = path.join(path.dirname(require.resolve('typescript').replace(/\\/g, '/')), 'lib.es6.d.ts');
        this.cacheFiles = Object.create(null);
        this.imageCache = new imgCache.ImgCache();
        this.compilationResult = new CompilationResult();
    }
    addMessageFromBB(isError, code, message, source, pos, end) {
        var output = '';
        let text = `BB${code}: ${message}`;
        var locStart = source.getLineAndCharacterOfPosition(pos);
        var locEnd = source.getLineAndCharacterOfPosition(end);
        output += `${source.fileName}(${locStart.line + 1},${locStart.character + 1}): `;
        this.compilationResult.addMessage(isError, source.fileName, text, [locStart.line + 1, locStart.character + 1, locEnd.line + 1, locEnd.character + 1]);
        var category = isError ? "error" : "warning";
        output += `${category} ${text}${ts.sys.newLine}`;
        this.logCallback(output);
    }
    reportDiagnostic(diagnostic) {
        var output = '';
        let text = `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
        if (diagnostic.file) {
            var locStart = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
            var locEnd = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start + diagnostic.length);
            output += `${diagnostic.file.fileName}(${locStart.line + 1},${locStart.character + 1}): `;
            this.compilationResult.addMessage(diagnostic.category === ts.DiagnosticCategory.Error, diagnostic.file.fileName, text, [locStart.line + 1, locStart.character + 1, locEnd.line + 1, locEnd.character + 1]);
        }
        var category = ts.DiagnosticCategory[diagnostic.category].toLowerCase();
        output += `${category} ${text}${ts.sys.newLine}`;
        this.logCallback(output);
    }
    reportDiagnostics(diagnostics) {
        for (var i = 0; i < diagnostics.length; i++) {
            this.reportDiagnostic(diagnostics[i]);
        }
    }
    clearFileTimeModifications() {
        let cacheFiles = this.cacheFiles;
        let names = Object.keys(cacheFiles);
        for (let i = 0; i < names.length; i++) {
            cacheFiles[names[i]].curTime = undefined;
        }
    }
    forceRebuildNextCompile(project) {
        if (project) {
            project.moduleMap = null;
            project.depJsFiles = null;
            project.depAssetFiles = null;
        }
        let cacheFiles = this.cacheFiles;
        let names = Object.keys(cacheFiles);
        for (let i = 0; i < names.length; i++) {
            cacheFiles[names[i]].infoTime = undefined;
            cacheFiles[names[i]].outputTime = undefined;
        }
    }
    addOverride(fn, varDecl, value) {
        let o = this.overrides[fn];
        if (o == null) {
            o = [];
            this.overrides[fn] = o;
        }
        o.push({ varDecl, value });
    }
    findVarDecl(project, program, exports, expName) {
        let tc = program.getTypeChecker();
        let symb = exports.find(v => v.name == expName);
        if (symb == null) {
            project.logCallback(`Cannot find export ${expName} in ${exports.map(v => v.name).join(',')}`);
            return null;
        }
        let decls = symb.getDeclarations();
        if (decls.length != 1) {
            project.logCallback(`Not unique declaration of ${expName}`);
            return null;
        }
        let decl = decls[0];
        if (decl.kind === ts.SyntaxKind.ExportSpecifier) {
            let exports2 = tc.getExportsOfModule(tc.getSymbolAtLocation(decl.parent.parent.moduleSpecifier));
            let expName2 = decl.propertyName.text;
            return this.findVarDecl(project, program, exports2, expName2);
        }
        if (decl.kind === ts.SyntaxKind.VariableDeclaration) {
            return decl;
        }
        project.logCallback(`Don't know how to override ${expName} in ${ts.SyntaxKind[decl.kind]}`);
        return null;
    }
    prepareToApplyConstantOverride(project, program) {
        let overrides = project.constantOverrides;
        let moduleList = Object.keys(overrides);
        let tc = program.getTypeChecker();
        for (let i = 0; i < moduleList.length; i++) {
            let moduleName = moduleList[i];
            let moduleInfo = project.moduleMap[moduleName];
            if (moduleInfo == null) {
                project.logCallback(`Defined module override not found (${moduleName})`);
                continue;
            }
            let exports = tc.getExportsOfModule(program.getSourceFile(moduleInfo.defFile).symbol);
            let overridesModule = overrides[moduleName];
            let overridesNames = Object.keys(overridesModule);
            for (let j = 0; j < overridesNames.length; j++) {
                let expName = overridesNames[j];
                let decl = this.findVarDecl(project, program, exports, expName);
                if (decl) {
                    this.addOverride(decl.getSourceFile().fileName, decl, overridesModule[expName]);
                }
            }
        }
    }
    getResult() {
        return this.compilationResult;
    }
    compile(project) {
        project.liveReloadIdx = (project.liveReloadIdx | 1);
        let mainList = (Array.isArray(project.main) ? project.main : [project.main]);
        mainList = mainList.map(p => path.normalize(p));
        project.logCallback = project.logCallback || ((text) => console.log(text));
        this.logCallback = project.logCallback;
        project.writeFileCallback = project.writeFileCallback || ((filename, content) => fs.writeFileSync(filename, content));
        let jsWriteFileCallback = project.writeFileCallback;
        let ndir = project.dir.toLowerCase() + "/";
        function relativizeToProject(p) {
            let nfn = p.toLowerCase();
            if (nfn.substr(0, ndir.length) === ndir) {
                p = p.substr(ndir.length);
            }
            return p;
        }
        let resolvePathString = project.resolvePathString || project.resourcesAreRelativeToProjectDir ?
            (p, s, t) => relativizeToProject(pathUtils.join(p, t)) : (p, s, t) => relativizeToProject(/^node_modules\//.test(t) ? pathUtils.join(p, t) : pathUtils.join(path.dirname(s), t));
        this.resolvePathStringLiteral = ((nn) => resolvePathString(project.dir, nn.getSourceFile().fileName, nn.text));
        if (project.totalBundle) {
            project.options.sourceMap = false;
            project.options.removeComments = false;
        }
        else if (project.fastBundle) {
            project.options.sourceMap = true;
        }
        if (!project.noBobrilJsx) {
            project.options.jsx = ts.JsxEmit.React;
            project.options.reactNamespace = "b";
        }
        project.options.experimentalDecorators = true;
        project.options.lib = defaultLibs();
        if (project.compilerOptions) {
            Object.assign(project.options, project.compilerOptions);
        }
        addLibPrefixPostfix(project.options.lib);
        // workaround for TypeScript does not want to overwrite JS files.
        project.options.outDir = "virtual/";
        project.options.rootDir = project.dir;
        if (project.totalBundle || project.fastBundle) {
            project.options.noEmitHelpers = true;
            project.options.module = ts.ModuleKind.CommonJS;
            project.commonJsTemp = project.commonJsTemp || Object.create(null);
            project.sourceMapMap = project.sourceMapMap || Object.create(null);
            jsWriteFileCallback = (filename, content) => {
                if (/\.js\.map$/i.test(filename)) {
                    let sm = sourceMap.parseSourceMap(content);
                    project.sourceMapMap[filename.replace(/\.js\.map$/i, "").toLowerCase()] = sm;
                }
                else if (/\.js$/i.test(filename)) {
                    content = simpleHelpers.removeLinkToSourceMap(content);
                    project.commonJsTemp[filename.toLowerCase()] = content;
                }
                else if (/\.d\.ts$/i.test(filename)) {
                    // Skip .d.ts files
                }
                else {
                    project.commonJsTemp[filename.toLowerCase()] = content;
                }
            };
            project.bundleJs = "bundle.js";
        }
        let shortenFileName = (fn) => fn;
        let shortenFileNameAddPath = shortenFileName;
        if (project.totalBundle) {
            shortenFileName = shortenFileName_1.createFileNameShortener();
            shortenFileNameAddPath = shortenFileName;
            if (project.outputSubDir) {
                shortenFileNameAddPath = (fn) => project.outputSubDir + "/" + shortenFileName(fn);
            }
            project.bundleJs = shortenFileNameAddPath(project.bundleJs);
        }
        if (project.spriteMerge) {
            shortenFileName('bundle.png');
        }
        let jsWriteFileCallbackUnnormalized = jsWriteFileCallback;
        jsWriteFileCallback = (filename, content) => {
            jsWriteFileCallbackUnnormalized(relativizeToProject(filename), content);
        };
        project.moduleMap = project.moduleMap || Object.create(null);
        project.depJsFiles = project.depJsFiles || Object.create(null);
        project.depAssetFiles = project.depAssetFiles || Object.create(null);
        project.cssToLink = [];
        this.clearMaxTimeForDeps();
        let mainChangedList = [];
        for (let i = 0; i < mainList.length; i++) {
            let main = mainList[i];
            let mainCache = this.calcMaxTimeForDeps(main, project.dir, false);
            if (mainCache.maxTimeForDeps !== undefined || project.spriteMerge) {
                mainChangedList.push(main);
            }
        }
        if (mainChangedList.length === 0) {
            return Promise.resolve(null);
        }
        let program = ts.createProgram(mainChangedList, project.options, this.createCompilerHost(this, project, jsWriteFileCallback));
        let diagnostics = program.getSyntacticDiagnostics();
        let sourceFiles = program.getSourceFiles();
        for (let i = 0; i < sourceFiles.length; i++) {
            let src = sourceFiles[i];
            this.compilationResult.clearFileName(src.fileName);
        }
        this.reportDiagnostics(diagnostics);
        if (diagnostics.length === 0) {
            let diagnostics = program.getGlobalDiagnostics();
            this.reportDiagnostics(diagnostics);
            if (diagnostics.length === 0) {
                let diagnostics = program.getSemanticDiagnostics();
                this.reportDiagnostics(diagnostics);
            }
        }
        if (this.compilationResult.errors > 0) {
            return Promise.resolve(null);
        }
        let restorationMemory = [];
        this.overrides = Object.create(null);
        if (project.constantOverrides) {
            this.prepareToApplyConstantOverride(project, program);
        }
        var bundleCache = null;
        if (project.spriteMerge) {
            if (project.imgBundleCache) {
                bundleCache = project.imgBundleCache;
            }
            else {
                bundleCache = new imgCache.ImgBundleCache(this.imageCache);
                project.imgBundleCache = bundleCache;
            }
            bundleCache.clear(false);
        }
        let prom = Promise.resolve(null);
        let assetMap = Object.create(null);
        let tc = program.getTypeChecker();
        for (let i = 0; i < sourceFiles.length; i++) {
            let src = sourceFiles[i];
            if (/\.d\.ts$/i.test(src.fileName))
                continue; // skip searching default lib
            let overr = this.overrides[src.fileName];
            if (overr != null) {
                restorationMemory.push(BuildHelpers.applyOverrides(overr));
            }
            let cached = this.getCachedFileExistence(src.fileName, project.dir);
            if (cached.sourceTime !== cached.infoTime) {
                cached.info = BuildHelpers.gatherSourceInfo(src, tc, this.resolvePathStringLiteral);
                cached.infoTime = cached.sourceTime;
            }
            let info = cached.info;
            if (project.spriteMerge) {
                for (let j = 0; j < info.sprites.length; j++) {
                    let si = info.sprites[j];
                    if (si.name == null)
                        continue;
                    bundleCache.add(pathUtils.join(project.dir, si.name), si.color, si.width, si.height, si.x, si.y);
                }
            }
            if (project.textForTranslationReporter) {
                let trs = info.trs;
                for (let j = 0; j < trs.length; j++) {
                    let message = trs[j].message;
                    if (typeof message === 'string')
                        project.textForTranslationReporter(trs[j], this.compilationResult);
                }
            }
            for (let j = 0; j < info.assets.length; j++) {
                let sa = info.assets[j];
                if (sa.name == null) {
                    this.addMessageFromBB(false, 2, "Used b.asset without compile time constant - ignoring", info.sourceFile, sa.callExpression.getStart(), sa.callExpression.getEnd());
                    continue;
                }
                let assetName = sa.name;
                let result = plugins.pluginsLoader.executeEntryMethod(plugins.EntryMethodType.handleAsset, assetName, shortenFileNameAddPath, project);
                if (result.length == 0) {
                    let newName = assetName;
                    if (!isCssByExt(assetName) && !isJsByExt(assetName)) {
                        newName = shortenFileNameAddPath(assetName);
                    }
                    assetMap[assetName] = newName;
                    project.depAssetFiles[assetName] = newName;
                }
                else if (result.length == 1) {
                    prom = prom.then(() => {
                        return Promise.resolve(result[0]).then((val) => {
                            if (val && val["_BBError"]) {
                                this.addMessageFromBB(true, 3, val["_BBError"], info.sourceFile, sa.callExpression.getStart(), sa.callExpression.getEnd());
                            }
                            else {
                                assetMap[assetName] = val;
                            }
                        });
                    });
                }
                else {
                    this.addMessageFromBB(true, 1, "Multiple plugins handled asset " + assetName, info.sourceFile, sa.callExpression.getStart(), sa.callExpression.getEnd());
                    assetMap[assetName] = assetName;
                }
            }
        }
        if (project.spriteMerge) {
            if (bundleCache.wasChange()) {
                prom = prom.then(() => bundleCache.build());
                prom = prom.then((bi) => {
                    return imageOps.savePNG2Buffer(bi);
                });
                prom = prom.then((b) => {
                    project.bundlePng = shortenFileNameAddPath('bundle.png');
                    project.writeFileCallback(project.bundlePng, b);
                    return null;
                });
            }
        }
        project.htmlHeadExpanded = (project.htmlHead || "").replace(/<<[^>]+>>/g, (s) => {
            s = s.substr(2, s.length - 4);
            let shortened = shortenFileNameAddPath(s);
            project.depAssetFiles[s] = shortened;
            return shortened;
        });
        // Recalculate fresness of all files
        this.clearMaxTimeForDeps();
        for (let i = 0; i < sourceFiles.length; i++) {
            this.calcMaxTimeForDeps(sourceFiles[i].fileName, project.dir, true);
        }
        prom = prom.then(() => {
            project.realRootRel = path.relative(program.getCommonSourceDirectory(), project.dir);
            if (project.realRootRel !== "") {
                project.realRootRel = project.realRootRel + "/";
            }
            for (let i = 0; i < sourceFiles.length; i++) {
                let src = sourceFiles[i];
                if (/\.d\.ts$/i.test(src.fileName))
                    continue; // skip searching default lib
                let overr = this.overrides[src.fileName];
                if (overr != null) {
                    BuildHelpers.applyOverridesHarder(overr);
                }
                let cached = this.getCachedFileExistence(src.fileName, project.dir);
                if (cached.maxTimeForDeps !== null && cached.outputTime != null && cached.maxTimeForDeps <= cached.outputTime
                    && !project.spriteMerge) {
                    continue;
                }
                if (/\/bobril-g11n\/index.ts$/.test(src.fileName)) {
                    this.addDepJsToOutput(project, bobrilDepsHelpers.numeralJsPath(), bobrilDepsHelpers.numeralJsFiles()[0]);
                    this.addDepJsToOutput(project, bobrilDepsHelpers.momentJsPath(), bobrilDepsHelpers.momentJsFiles()[0]);
                }
                let info = cached.info;
                if (project.spriteMerge) {
                    for (let j = 0; j < info.sprites.length; j++) {
                        let si = info.sprites[j];
                        if (si.name == null)
                            continue;
                        let bundlePos = bundleCache.query(pathUtils.join(project.dir, si.name), si.color, si.width, si.height, si.x, si.y);
                        restorationMemory.push(BuildHelpers.rememberCallExpression(si.callExpression));
                        if (si.callExpression.arguments.length >= 2 && si.color === undefined) {
                            BuildHelpers.setMethod(si.callExpression, "spritebc");
                            BuildHelpers.setArgumentAst(si.callExpression, 0, si.callExpression.arguments[1]);
                            BuildHelpers.setArgument(si.callExpression, 1, bundlePos.width);
                            BuildHelpers.setArgument(si.callExpression, 2, bundlePos.height);
                            BuildHelpers.setArgument(si.callExpression, 3, bundlePos.x);
                            BuildHelpers.setArgument(si.callExpression, 4, bundlePos.y);
                            BuildHelpers.setArgumentCount(si.callExpression, 5);
                        }
                        else {
                            BuildHelpers.setMethod(si.callExpression, "spriteb");
                            BuildHelpers.setArgument(si.callExpression, 0, bundlePos.width);
                            BuildHelpers.setArgument(si.callExpression, 1, bundlePos.height);
                            BuildHelpers.setArgument(si.callExpression, 2, bundlePos.x);
                            BuildHelpers.setArgument(si.callExpression, 3, bundlePos.y);
                            BuildHelpers.setArgumentCount(si.callExpression, 4);
                        }
                    }
                }
                else {
                    for (let j = 0; j < info.sprites.length; j++) {
                        let si = info.sprites[j];
                        if (si.name == null)
                            continue;
                        let newname = si.name;
                        project.depAssetFiles[si.name] = shortenFileNameAddPath(newname);
                        restorationMemory.push(BuildHelpers.rememberCallExpression(si.callExpression));
                        BuildHelpers.setArgument(si.callExpression, 0, newname);
                    }
                }
                for (let j = 0; j < info.assets.length; j++) {
                    let sa = info.assets[j];
                    if (sa.name == null) {
                        continue;
                    }
                    let assetName = sa.name;
                    restorationMemory.push(BuildHelpers.rememberCallExpression(sa.callExpression));
                    BuildHelpers.setArgument(sa.callExpression, 0, assetMap[assetName]);
                }
                if (project.compileTranslation) {
                    project.compileTranslation.startCompileFile(src.fileName);
                    let trs = info.trs;
                    for (let j = 0; j < trs.length; j++) {
                        let message = trs[j].message;
                        if (typeof message === 'string' && trs[j].justFormat != true) {
                            let id = project.compileTranslation.addUsageOfMessage(trs[j]);
                            let ce = trs[j].callExpression;
                            restorationMemory.push(BuildHelpers.rememberCallExpression(ce));
                            BuildHelpers.setArgument(ce, 0, id);
                            if (ce.arguments.length > 2) {
                                BuildHelpers.setArgumentCount(ce, 2);
                            }
                        }
                    }
                    project.compileTranslation.finishCompileFile(src.fileName);
                }
                for (let j = 0; j < info.styleDefs.length; j++) {
                    let sd = info.styleDefs[j];
                    let remembered = false;
                    let skipEx = sd.isEx ? 1 : 0;
                    if (project.liveReloadStyleDefs) {
                        remembered = true;
                        restorationMemory.push(BuildHelpers.rememberCallExpression(sd.callExpression));
                        BuildHelpers.setArgumentAst(sd.callExpression, skipEx, BuildHelpers.buildLambdaReturningArray(sd.callExpression.arguments.slice(skipEx, 2 + skipEx)));
                        BuildHelpers.setArgument(sd.callExpression, 1 + skipEx, null);
                    }
                    if (project.debugStyleDefs) {
                        let name;
                        if (project.prefixStyleDefs) {
                            name = sd.name;
                            if (!name) {
                                if (sd.callExpression.arguments.length >= 3 + skipEx) {
                                    if (!remembered) {
                                        restorationMemory.push(BuildHelpers.rememberCallExpression(sd.callExpression));
                                    }
                                    BuildHelpers.setArgumentAst(sd.callExpression, 2 + skipEx, BuildHelpers.concat(BuildHelpers.createNodeFromValue(project.prefixStyleDefs), sd.callExpression.arguments[2 + skipEx]));
                                }
                                continue;
                            }
                            name = project.prefixStyleDefs + name;
                        }
                        else {
                            name = sd.name;
                            if (sd.userNamed)
                                continue;
                            if (!name)
                                continue;
                        }
                        if (!remembered) {
                            restorationMemory.push(BuildHelpers.rememberCallExpression(sd.callExpression));
                        }
                        BuildHelpers.setArgumentCount(sd.callExpression, 3 + skipEx);
                        BuildHelpers.setArgument(sd.callExpression, 2 + skipEx, name);
                    }
                    else if (project.releaseStyleDefs) {
                        if (sd.callExpression.arguments.length <= 2 + skipEx)
                            continue;
                        if (!remembered) {
                            restorationMemory.push(BuildHelpers.rememberCallExpression(sd.callExpression));
                        }
                        BuildHelpers.setArgumentCount(sd.callExpression, 2 + skipEx);
                    }
                    else if (project.prefixStyleDefs) {
                        if (!sd.name) {
                            if (sd.callExpression.arguments.length >= 3 + skipEx) {
                                if (!remembered) {
                                    restorationMemory.push(BuildHelpers.rememberCallExpression(sd.callExpression));
                                }
                                BuildHelpers.setArgumentAst(sd.callExpression, 2 + skipEx, BuildHelpers.concat(BuildHelpers.createNodeFromValue(project.prefixStyleDefs), sd.callExpression.arguments[2 + skipEx]));
                            }
                            continue;
                        }
                        if (!remembered) {
                            restorationMemory.push(BuildHelpers.rememberCallExpression(sd.callExpression));
                        }
                        BuildHelpers.setArgument(sd.callExpression, 2 + skipEx, project.prefixStyleDefs + sd.name);
                    }
                }
                var emitRes = program.emit(src);
                if (project.options.declaration)
                    this.reportDiagnostics(emitRes.diagnostics);
                cached.outputTime = cached.maxTimeForDeps || cached.sourceTime;
                for (let j = restorationMemory.length - 1; j >= 0; j--) {
                    restorationMemory[j]();
                }
            }
            let jsFiles = Object.keys(project.depJsFiles);
            for (let i = 0; i < jsFiles.length; i++) {
                let jsFile = jsFiles[i];
                let cached = this.getCachedFileExistence(jsFile, project.dir);
                if (cached.curTime == null) {
                    project.logCallback('Error: Dependent ' + jsFile + ' not found');
                    continue;
                }
                if (cached.outputTime == null || cached.curTime > cached.outputTime) {
                    this.updateCachedFileContent(cached);
                    if (cached.textTime !== cached.curTime) {
                        project.logCallback('Error: Dependent ' + jsFile + ' failed to load');
                        continue;
                    }
                    jsWriteFileCallback(project.depJsFiles[jsFile], new Buffer(cached.text, 'utf-8'));
                    cached.outputTime = cached.textTime;
                }
            }
            let prom = Promise.resolve();
            let assetFiles = Object.keys(project.depAssetFiles);
            let cssToMerge = [];
            for (let i = 0; i < assetFiles.length; i++) {
                prom = prom.then(v => ((i) => {
                    let assetFile = assetFiles[i];
                    let cached = this.getCachedFileExistence(assetFile, project.dir);
                    if (cached.curTime == null) {
                        project.logCallback('Error: Dependent ' + assetFile + ' not found');
                        return;
                    }
                    if (cached.outputTime == null || cached.curTime > cached.outputTime) {
                        this.updateCachedFileBuffer(cached);
                        if (cached.bufferTime !== cached.curTime) {
                            return;
                        }
                        if (isCssByExt(assetFile)) {
                            if (project.totalBundle) {
                                cssToMerge.push({ source: cached.buffer.toString(), from: assetFile });
                            }
                            else {
                                project.cssToLink.push(project.depAssetFiles[assetFile]);
                                return cssHelpers.processCss(cached.buffer.toString(), assetFile, (url, from) => {
                                    let hi = url.lastIndexOf('#');
                                    let hi2 = url.lastIndexOf('?');
                                    if (hi < 0)
                                        hi = url.length;
                                    if (hi2 < 0)
                                        hi2 = url.length;
                                    if (hi2 < hi)
                                        hi = hi2;
                                    let res = resolvePathString(project.dir, from + "/a", url.substr(0, hi));
                                    project.depAssetFiles[res] = res;
                                    return url;
                                }).then(v => {
                                    project.writeFileCallback(project.depAssetFiles[assetFile], new Buffer(v.css));
                                }, (e) => {
                                    project.logCallback(e.toString());
                                });
                            }
                        }
                    }
                })(i));
            }
            prom = prom.then(() => {
                if (cssToMerge.length > 0) {
                    return cssHelpers.concatenateCssAndMinify(cssToMerge, (url, from) => {
                        let hi = url.lastIndexOf('#');
                        let hi2 = url.lastIndexOf('?');
                        if (hi < 0)
                            hi = url.length;
                        if (hi2 < 0)
                            hi2 = url.length;
                        if (hi2 < hi)
                            hi = hi2;
                        let res = resolvePathString(project.dir, from + "/a", url.substr(0, hi));
                        let resres = shortenFileNameAddPath(res);
                        project.depAssetFiles[res] = resres;
                        return shortenFileName(res) + url.substr(hi);
                    }).then(v => {
                        let bundleCss = shortenFileNameAddPath('bundle.css');
                        project.cssToLink.push(bundleCss);
                        project.writeFileCallback(bundleCss, new Buffer(v.css));
                    });
                }
            });
            return prom.then(() => {
                let assetFiles = Object.keys(project.depAssetFiles);
                for (let i = 0; i < assetFiles.length; i++) {
                    let assetFile = assetFiles[i];
                    let cached = this.getCachedFileExistence(assetFile, project.dir);
                    if (cached.curTime == null) {
                        project.logCallback('Error: Dependent ' + assetFile + ' not found');
                        continue;
                    }
                    if (cached.outputTime == null || cached.curTime > cached.outputTime) {
                        this.updateCachedFileBuffer(cached);
                        if (cached.bufferTime !== cached.curTime) {
                            project.logCallback('Error: Dependent ' + assetFile + ' failed to load');
                            continue;
                        }
                        if (!isCssByExt(assetFile) && !isJsByExt(assetFile)) {
                            project.writeFileCallback(project.depAssetFiles[assetFile], cached.buffer);
                        }
                        cached.outputTime = cached.textTime;
                    }
                }
                if (project.totalBundle) {
                    let mainJsList = mainList.filter((nn) => !/\.d\.ts$/.test(nn)).map((nn) => nn.replace(/\.tsx?$/, '.js'));
                    let allJsFiles = Object.keys(project.commonJsTemp);
                    if (allJsFiles.some((n) => /\/bobriln\/index/.test(n)))
                        mainJsList.splice(0, 0, "node_modules/bobriln/index.js");
                    else if (allJsFiles.some((n) => /\/bobril\/index/.test(n))) {
                        mainJsList.splice(0, 0, "node_modules/bobril/index.js");
                    }
                    let that = this;
                    let bp = {
                        compress: project.compress,
                        mangle: project.mangle,
                        beautify: project.beautify,
                        defines: project.defines,
                        getMainFiles() {
                            return mainJsList;
                        },
                        checkFileModification(name) {
                            if (/\.js$/i.test(name)) {
                                let cached = that.getCachedFileContent(name.replace(/\.js$/i, '.ts'), project.dir);
                                if (cached.curTime != null)
                                    return cached.outputTime;
                                cached = that.getCachedFileContent(name.replace(/\.js$/i, '.tsx'), project.dir);
                                if (cached.curTime != null)
                                    return cached.outputTime;
                            }
                            let cached = that.getCachedFileContent(name, project.dir);
                            return cached.curTime;
                        },
                        readContent(name) {
                            let jsout = project.commonJsTemp[name.toLowerCase()];
                            if (jsout !== undefined)
                                return jsout.toString('utf-8');
                            let cached = that.getCachedFileContent(name, project.dir);
                            if (cached.textTime == null) {
                                project.logCallback('Cannot read content of ' + name + ' in dir ' + project.dir);
                                return "";
                            }
                            return cached.text;
                        },
                        writeBundle(content) {
                            let res = new dynamicBuffer_1.DynamicBuffer();
                            for (let i = 0; i < assetFiles.length; i++) {
                                let assetFile = assetFiles[i];
                                if (!isJsByExt(assetFile))
                                    continue;
                                let cached = that.getCachedFileExistence(assetFile, project.dir);
                                if (cached.curTime == null || cached.bufferTime !== cached.curTime) {
                                    continue;
                                }
                                res.addBuffer(cached.buffer);
                                res.addByte(10);
                            }
                            res.addString(content);
                            project.writeFileCallback(project.bundleJs, res.toBuffer());
                        }
                    };
                    bundler.bundle(bp);
                }
                else if (project.fastBundle) {
                    let allFilesInJsBundle = Object.keys(project.commonJsTemp);
                    let res = new sourceMap.SourceMapBuilder();
                    res.addLines(bobrilDepsHelpers.tslibSource());
                    for (let i = 0; i < assetFiles.length; i++) {
                        let assetFile = assetFiles[i];
                        if (!isJsByExt(assetFile))
                            continue;
                        let cached = this.getCachedFileExistence(assetFile, project.dir);
                        if (cached.curTime == null || cached.bufferTime !== cached.curTime) {
                            continue;
                        }
                        res.addSource(cached.buffer);
                    }
                    for (let i = 0; i < allFilesInJsBundle.length; i++) {
                        let name = allFilesInJsBundle[i];
                        let nameWOExt = name.replace(/\.js$/i, '');
                        let sm = project.sourceMapMap[nameWOExt];
                        let content = project.commonJsTemp[name];
                        res.addLine("R(\'" + nameWOExt + "\',function(require, module, exports, global){");
                        res.addSource(content, sm);
                        res.addLine("});");
                    }
                    res.addLine("//# sourceMappingURL=" + shortenFileName("bundle.js") + ".map");
                    project.writeFileCallback(project.bundleJs + '.map', res.toSourceMapBuffer(project.options.sourceRoot));
                    project.writeFileCallback(project.bundleJs, res.toContent());
                }
                if (project.spriteMerge) {
                    bundleCache.clear(true);
                }
                if (this.compilationResult.errors == 0) {
                    project.liveReloadIdx++;
                }
                return null;
            });
        });
        return prom;
    }
    copyToProjectIfChanged(name, dir, outName, write) {
        let cache = this.getCachedFileExistence(name, dir);
        if (cache.curTime == null) {
            this.logCallback('Cannot copy ' + name + ' from ' + dir + ' to ' + outName + ' because it does not exist');
            return;
        }
        if (cache.outputTime == null || cache.curTime > cache.outputTime) {
            let buf = fs.readFileSync(cache.fullName);
            write(outName, buf);
            cache.outputTime = cache.curTime;
        }
    }
    addDepJsToOutput(project, srcDir, name) {
        project.depJsFiles[path.join(srcDir, name)] = name;
    }
    clearMaxTimeForDeps() {
        let cacheFiles = this.cacheFiles;
        let names = Object.keys(cacheFiles);
        for (let i = 0; i < names.length; i++) {
            cacheFiles[names[i]].maxTimeForDeps = undefined;
        }
    }
    getCachedFileExistence(fileName, baseDir) {
        let resolvedName = pathUtils.isAbsolutePath(fileName) ? fileName : path.join(baseDir, fileName);
        let resolvedNameLowerCased = resolvedName.toLowerCase();
        let cached = this.cacheFiles[resolvedNameLowerCased];
        if (cached === undefined) {
            cached = { fullName: resolvedName };
            this.cacheFiles[resolvedNameLowerCased] = cached;
        }
        if (cached.curTime == null) {
            if (cached.curTime === null) {
                return cached;
            }
            try {
                cached.curTime = fs.statSync(resolvedName).mtime.getTime();
            }
            catch (er) {
                cached.curTime = null;
                return cached;
            }
        }
        return cached;
    }
    updateCachedFileContent(cached) {
        if (cached.textTime !== cached.curTime) {
            let text;
            try {
                text = fs.readFileSync(cached.fullName).toString();
            }
            catch (er) {
                cached.textTime = null;
                return cached;
            }
            cached.textTime = cached.curTime;
            cached.text = text;
        }
    }
    updateCachedFileBuffer(cached) {
        if (cached.bufferTime !== cached.curTime) {
            let buffer;
            try {
                buffer = fs.readFileSync(cached.fullName);
            }
            catch (er) {
                cached.bufferTime = null;
                return cached;
            }
            cached.bufferTime = cached.curTime;
            cached.buffer = buffer;
        }
    }
    getCachedFileContent(fileName, baseDir) {
        let cached = this.getCachedFileExistence(fileName, baseDir);
        if (cached.curTime === null) {
            cached.textTime = null;
            return cached;
        }
        this.updateCachedFileContent(cached);
        return cached;
    }
    getCachedFileBuffer(fileName, baseDir) {
        let cached = this.getCachedFileExistence(fileName, baseDir);
        if (cached.curTime === null) {
            cached.bufferTime = null;
            return cached;
        }
        this.updateCachedFileBuffer(cached);
        return cached;
    }
    calcMaxTimeForDeps(name, baseDir, ignoreOutputTime) {
        let cached = this.getCachedFileExistence(name, baseDir);
        if (cached.maxTimeForDeps !== undefined)
            return cached;
        cached.maxTimeForDeps = cached.curTime;
        if (cached.curTime === null)
            return cached;
        if (!ignoreOutputTime && cached.outputTime == null) {
            cached.maxTimeForDeps = null;
            return cached;
        }
        if (cached.curTime === cached.infoTime) {
            let deps = cached.info.sourceDeps;
            for (let i = 0; i < deps.length; i++) {
                let depCached = this.calcMaxTimeForDeps(deps[i][1], baseDir, ignoreOutputTime);
                if (depCached.maxTimeForDeps === null) {
                    cached.maxTimeForDeps = null;
                    return cached;
                }
                if (depCached.maxTimeForDeps > cached.maxTimeForDeps) {
                    cached.maxTimeForDeps = depCached.maxTimeForDeps;
                }
            }
        }
        return cached;
    }
    createCompilerHost(cc, project, writeFileCallback) {
        let currentDirectory = project.dir;
        let logCallback = project.logCallback;
        function getCanonicalFileName(fileName) {
            return fileName.toLowerCase();
        }
        function getCachedFileExistence(fileName) {
            return cc.getCachedFileExistence(fileName, currentDirectory);
        }
        function getCachedFileContent(fileName) {
            return cc.getCachedFileContent(fileName, currentDirectory);
        }
        function getSourceFile(fileName, languageVersion, onError) {
            let isDefLib = fileName === cc.defaultLibFilename;
            if (isDefLib) {
                if (cc.defLibPrecompiled)
                    return cc.defLibPrecompiled;
                let text;
                try {
                    text = fs.readFileSync(cc.defaultLibFilename).toString();
                }
                catch (er) {
                    if (onError)
                        onError('Opening ' + cc.defaultLibFilename + " failed with " + er);
                    return null;
                }
                cc.defLibPrecompiled = ts.createSourceFile(fileName, text, languageVersion, true);
                return cc.defLibPrecompiled;
            }
            let cached = getCachedFileContent(fileName);
            if (cached.textTime == null) {
                return null;
            }
            if (cached.sourceTime !== cached.textTime) {
                cached.sourceFile = ts.createSourceFile(fileName, cached.text, languageVersion, true);
                cached.sourceTime = cached.textTime;
            }
            return cached.sourceFile;
        }
        function writeFile(fileName, data, writeByteOrderMark, onError) {
            try {
                fileName = fileName.replace(new RegExp("^" + project.options.outDir), "");
                writeFileCallback(fileName, new Buffer(data));
            }
            catch (e) {
                if (onError) {
                    onError(e.message);
                }
            }
        }
        function resolveModuleExtension(moduleName, nameWithoutExtension, internalModule) {
            let cached = getCachedFileExistence(nameWithoutExtension + '.ts');
            if (cached.curTime !== null) {
                project.moduleMap[moduleName] = { defFile: nameWithoutExtension + '.ts', jsFile: nameWithoutExtension + '.js', isDefOnly: false, internalModule };
                return { resolvedFileName: nameWithoutExtension + '.ts', extension: ts.Extension.Ts };
            }
            cached = getCachedFileExistence(nameWithoutExtension + '.tsx');
            if (cached.curTime !== null) {
                project.moduleMap[moduleName] = { defFile: nameWithoutExtension + '.tsx', jsFile: nameWithoutExtension + '.js', isDefOnly: false, internalModule };
                return { resolvedFileName: nameWithoutExtension + '.tsx', extension: ts.Extension.Tsx };
            }
            cached = getCachedFileExistence(nameWithoutExtension + '.d.ts');
            if (cached.curTime !== null) {
                cached = getCachedFileExistence(nameWithoutExtension + '.js');
                if (cached.curTime !== null) {
                    cc.addDepJsToOutput(project, '.', nameWithoutExtension + '.js');
                    project.moduleMap[moduleName] = { defFile: nameWithoutExtension + '.d.ts', jsFile: nameWithoutExtension + '.js', isDefOnly: true, internalModule };
                    return { resolvedFileName: nameWithoutExtension + '.d.ts', extension: ts.Extension.Dts };
                }
            }
            cached = getCachedFileExistence(nameWithoutExtension + '.js');
            if (cached.curTime !== null) {
                cc.addDepJsToOutput(project, '.', nameWithoutExtension + '.js');
                project.moduleMap[moduleName] = { defFile: nameWithoutExtension + '.js', jsFile: nameWithoutExtension + '.js', isDefOnly: true, internalModule };
                return { resolvedFileName: nameWithoutExtension + '.js', extension: ts.Extension.Js };
            }
            return null;
        }
        function resolveModuleName(moduleName, containingFile) {
            if (moduleName.substr(0, 1) === '.') {
                if (/\/\//.test(moduleName)) {
                    project.logCallback('Import ' + moduleName + ' contains two slashes in row in ' + containingFile);
                }
                let res = resolveModuleExtension(path.join(path.dirname(containingFile), moduleName), path.join(path.dirname(containingFile), moduleName), true);
                if (res == null) {
                    project.logCallback('Module ' + moduleName + ' is not valid in ' + containingFile);
                    return null;
                }
                return res;
            }
            // support for deprecated import * as b from 'node_modules/bobril/index';
            let curDir = path.dirname(containingFile);
            do {
                let res = resolveModuleExtension(moduleName, path.join(curDir, moduleName), false);
                if (res != null) {
                    if (!/^node_modules\//i.test(moduleName)) {
                        //logCallback(`Wrong import '${moduleName}' in ${containingFile}. You must use relative path.`)
                    }
                    return res;
                }
                let previousDir = curDir;
                curDir = path.dirname(curDir);
                if (previousDir === curDir)
                    break;
            } while (true);
            // only flat node_modules currently supported (means only npm 3+)
            let pkgName = "node_modules/" + moduleName + "/package.json";
            let cached = getCachedFileContent(pkgName);
            if (cached.textTime == null) {
                return null;
            }
            let main;
            try {
                main = JSON.parse(cached.text).main;
            }
            catch (e) {
                project.logCallback('Cannot parse ' + pkgName + ' ' + e);
                return null;
            }
            if (main == null)
                main = 'index.js';
            let mainWithoutExt = main.replace(/\.[^/.]+$/, "");
            let res = resolveModuleExtension(moduleName, path.join("node_modules/" + moduleName, mainWithoutExt), false);
            if (res == null) {
                project.logCallback('Module ' + moduleName + ' is not valid in ' + containingFile);
                return null;
            }
            return res;
        }
        return {
            getSourceFile: getSourceFile,
            getDefaultLibFileName: function (options) { return cc.defaultLibFilename; },
            writeFile: writeFile,
            getCurrentDirectory: function () { return currentDirectory; },
            useCaseSensitiveFileNames: function () { return ts.sys.useCaseSensitiveFileNames; },
            getCanonicalFileName: getCanonicalFileName,
            getNewLine: function () { return '\n'; },
            getDirectories(name) {
                let res = fs.readdirSync(name).filter((v) => {
                    var stat = undefined;
                    try {
                        stat = fs.statSync(path.join(name, v));
                    }
                    catch (err) {
                    }
                    return stat && stat.isDirectory();
                });
                //console.log("getDir " + name + " ", res);
                return res;
            },
            directoryExists(name) {
                var stat = undefined;
                try {
                    stat = fs.statSync(name);
                }
                catch (err) {
                }
                //console.log("dirExists " + name + " " + (stat && stat.isDirectory()));
                return stat && stat.isDirectory();
            },
            fileExists(fileName) {
                if (fileName === cc.defaultLibFilename)
                    return true;
                let cached = getCachedFileExistence(fileName);
                if (cached.curTime === null)
                    return false;
                return true;
            },
            readFile(fileName) {
                let cached = getCachedFileContent(fileName);
                if (cached.textTime == null)
                    return null;
                return cached.text;
            },
            resolveModuleNames(moduleNames, containingFile) {
                return moduleNames.map((n) => {
                    let r = resolveModuleName(n, containingFile);
                    //console.log(n, containingFile, r);
                    return r;
                });
            }
        };
    }
}
exports.CompilationCache = CompilationCache;
//# sourceMappingURL=compilationCache.js.map