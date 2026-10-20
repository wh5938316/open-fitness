#!/usr/bin/env python3
"""Generate the dependency-free Xcode project for the two native applications."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
APPLE = ROOT / 'apps' / 'ios'
PROJECT = APPLE / 'OpenFitness.xcodeproj'
objects = {}

def identity(name):
    return hashlib.sha1(name.encode()).hexdigest()[:24].upper()

def obj(key_name, isa, **fields):
    key = identity(key_name)
    objects[key] = {'isa': isa, **fields}
    return key

def serialize(value, indent=0):
    pad = '\t' * indent
    if isinstance(value, dict):
        return '{\n' + ''.join(f'{pad}\t{json.dumps(k)} = {serialize(v, indent + 1)};\n' for k, v in value.items()) + pad + '}'
    if isinstance(value, list):
        return '(\n' + ''.join(f'{pad}\t{serialize(v, indent + 1)},\n' for v in value) + pad + ')'
    return str(value) if isinstance(value, int) else json.dumps(value)

config_ref = obj('Config', 'PBXFileReference', lastKnownFileType='text.xcconfig', path='Config.xcconfig', sourceTree='<group>')
package_ref = obj('Package', 'XCLocalSwiftPackageReference', relativePath='../../packages/OpenFitnessKit')

def configurations(name, settings):
    refs = []
    for mode in ('Debug', 'Release'):
        values = {**settings, 'SWIFT_OPTIMIZATION_LEVEL': '-Onone' if mode == 'Debug' else '-O', 'SWIFT_ACTIVE_COMPILATION_CONDITIONS': '$(inherited) DEBUG' if mode == 'Debug' else '$(inherited)', 'DEBUG_INFORMATION_FORMAT': 'dwarf' if mode == 'Debug' else 'dwarf-with-dsym'}
        refs.append(obj(name + mode, 'XCBuildConfiguration', buildSettings=values, name=mode, baseConfigurationReference=config_ref))
    return obj(name + 'Configurations', 'XCConfigurationList', buildConfigurations=refs, defaultConfigurationIsVisible=0, defaultConfigurationName='Release')

def target(name, platform, bundle, product_type):
    directory = APPLE / name
    source_refs, resource_refs, children = [], [], []
    for path in sorted(directory.glob('*')):
        if path.name.startswith('.'):
            continue
        if path.is_dir():
            if path.suffix != '.xcassets':
                continue
            filetype = 'folder.assetcatalog'
        else:
            if path.suffix not in ('.swift', '.plist', '.entitlements', '.xcprivacy'):
                continue
            filetype = {'.swift': 'sourcecode.swift', '.plist': 'text.plist.xml', '.entitlements': 'text.plist.entitlements', '.xcprivacy': 'text.xml'}.get(path.suffix, 'text')
        ref = obj(name + path.name, 'PBXFileReference', lastKnownFileType=filetype, path=path.name, sourceTree='<group>')
        children.append(ref)
        if path.suffix == '.swift':
            source_refs.append(obj(name + path.name + 'Build', 'PBXBuildFile', fileRef=ref))
        elif path.suffix in ('.xcassets', '.xcprivacy'):
            resource_refs.append(obj(name + path.name + 'Build', 'PBXBuildFile', fileRef=ref))
    localized = []
    for language in ('en', 'zh-Hans'):
        if (directory / (language + '.lproj') / 'InfoPlist.strings').exists():
            localized.append(obj(name + language, 'PBXFileReference', lastKnownFileType='text.plist.strings', name=language, path=language + '.lproj/InfoPlist.strings', sourceTree='<group>'))
    if localized:
        variant = obj(name + 'Localizations', 'PBXVariantGroup', children=localized, name='InfoPlist.strings', sourceTree='<group>')
        children.append(variant); resource_refs.append(obj(name + 'LocalizationsBuild', 'PBXBuildFile', fileRef=variant))
    group = obj(name + 'Group', 'PBXGroup', children=children, path=name, sourceTree='<group>')
    product = obj(name + 'Product', 'PBXFileReference', explicitFileType='wrapper.cfbundle' if platform == 'test' else 'wrapper.application', includeInIndex=0, path=name + ('.xctest' if platform == 'test' else '.app'), sourceTree='BUILT_PRODUCTS_DIR')
    sources = obj(name + 'Sources', 'PBXSourcesBuildPhase', buildActionMask=2147483647, files=source_refs, runOnlyForDeploymentPostprocessing=0)
    resources = obj(name + 'Resources', 'PBXResourcesBuildPhase', buildActionMask=2147483647, files=resource_refs, runOnlyForDeploymentPostprocessing=0)
    package_product = obj(name + 'Kit', 'XCSwiftPackageProductDependency', package=package_ref, productName='OpenFitnessKit')
    frameworks = obj(name + 'Frameworks', 'PBXFrameworksBuildPhase', buildActionMask=2147483647, files=[] if platform == 'test' else [obj(name + 'KitBuild', 'PBXBuildFile', productRef=package_product)], runOnlyForDeploymentPostprocessing=0)
    settings = {'PRODUCT_BUNDLE_IDENTIFIER': bundle, 'PRODUCT_NAME': '$(TARGET_NAME)', 'SDKROOT': 'watchos' if platform == 'watch' else 'iphoneos', 'SUPPORTED_PLATFORMS': 'watchos watchsimulator' if platform == 'watch' else 'iphoneos iphonesimulator', 'TARGETED_DEVICE_FAMILY': '4' if platform == 'watch' else '1,2', 'WATCHOS_DEPLOYMENT_TARGET' if platform == 'watch' else 'IPHONEOS_DEPLOYMENT_TARGET': '26.0', 'SWIFT_EMIT_LOC_STRINGS': 'YES', 'ENABLE_USER_SCRIPT_SANDBOXING': 'YES', 'LD_RUNPATH_SEARCH_PATHS': '$(inherited) @executable_path/Frameworks', 'GENERATE_INFOPLIST_FILE': 'YES'}
    if platform == 'test':
        settings['TEST_TARGET_NAME'] = 'OpenFitness'
    else:
        settings.update({'INFOPLIST_FILE': name + '/Info.plist', 'CODE_SIGN_ENTITLEMENTS': name + '/' + name + '.entitlements', 'ASSETCATALOG_COMPILER_APPICON_NAME': 'AppIcon', 'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME': 'AccentColor'})
    if platform == 'watch':
        settings.update({'SKIP_INSTALL': 'YES'})
    target_id = obj(name + 'Target', 'PBXNativeTarget', buildConfigurationList=configurations(name, settings), buildPhases=[sources, frameworks, resources], buildRules=[], dependencies=[], name=name, productName=name, productReference=product, productType=product_type, packageProductDependencies=[] if platform == 'test' else [package_product])
    return target_id, group, product

ios, ios_group, ios_product = target('OpenFitness', 'ios', 'org.openfitness.app', 'com.apple.product-type.application')
watch, watch_group, watch_product = target('OpenFitnessWatch', 'watch', 'org.openfitness.app.watchkitapp', 'com.apple.product-type.application')
tests, tests_group, tests_product = target('OpenFitnessUITests', 'test', 'org.openfitness.app.uitests', 'com.apple.product-type.bundle.ui-testing')
project_id = identity('Project')

def dependency(source, destination, name):
    proxy = obj(name + 'Proxy', 'PBXContainerItemProxy', containerPortal=project_id, proxyType=1, remoteGlobalIDString=destination, remoteInfo=name)
    dep = obj(name + 'Dependency', 'PBXTargetDependency', target=destination, targetProxy=proxy)
    objects[source]['dependencies'].append(dep)

dependency(ios, watch, 'OpenFitnessWatch')
dependency(tests, ios, 'OpenFitness')
embed_file = obj('EmbedWatchFile', 'PBXBuildFile', fileRef=watch_product, settings={'ATTRIBUTES': ['RemoveHeadersOnCopy']})
embed = obj('EmbedWatch', 'PBXCopyFilesBuildPhase', buildActionMask=2147483647, dstPath='$(CONTENTS_FOLDER_PATH)/Watch', dstSubfolderSpec=16, files=[embed_file], name='Embed Watch Content', runOnlyForDeploymentPostprocessing=0)
objects[ios]['buildPhases'].append(embed)
products = obj('Products', 'PBXGroup', children=[ios_product, watch_product, tests_product], name='Products', sourceTree='<group>')
root_group = obj('RootGroup', 'PBXGroup', children=[ios_group, watch_group, tests_group, config_ref, products], sourceTree='<group>')
obj('Project', 'PBXProject', attributes={'BuildIndependentTargetsInParallel': 'YES', 'LastUpgradeCheck': '2650', 'TargetAttributes': {tests: {'TestTargetID': ios}}}, buildConfigurationList=configurations('Project', {'CLANG_ENABLE_MODULES': 'YES', 'SWIFT_VERSION': '6.0'}), compatibilityVersion='Xcode 14.0', developmentRegion='en', hasScannedForEncodings=0, knownRegions=['en', 'zh-Hans', 'Base'], mainGroup=root_group, productRefGroup=products, projectDirPath='', projectRoot='', targets=[ios, watch, tests], packageReferences=[package_ref])
PROJECT.mkdir(exist_ok=True)
(PROJECT / 'project.pbxproj').write_text('// !$*UTF8*$!\n' + serialize({'archiveVersion': 1, 'classes': {}, 'objectVersion': 56, 'objects': objects, 'rootObject': project_id}) + '\n')
schemes = PROJECT / 'xcshareddata' / 'xcschemes'; schemes.mkdir(parents=True, exist_ok=True)
def ref(target_id, name):
    return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target_id}" BuildableName="{name}.app" BlueprintName="{name}" ReferencedContainer="container:OpenFitness.xcodeproj"/>'
for name, target_id in [('OpenFitness', ios), ('OpenFitnessWatch', watch)]:
    test_action = f'<TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{tests}" BuildableName="OpenFitnessUITests.xctest" BlueprintName="OpenFitnessUITests" ReferencedContainer="container:OpenFitness.xcodeproj"/></TestableReference>' if name == 'OpenFitness' else ''
    scheme = f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2650" version="1.7">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref(target_id, name)}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables>{test_action}</Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref(target_id, name)}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref(target_id, name)}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>'''
    (schemes / (name + '.xcscheme')).write_text(scheme + '\n')
print('Generated apps/ios/OpenFitness.xcodeproj with iOS, watchOS, and UI test targets.')
