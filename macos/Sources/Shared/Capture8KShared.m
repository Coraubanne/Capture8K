#import "Capture8KShared.h"
#import <AppKit/AppKit.h>
#import <sys/sysctl.h>
#import <unistd.h>

NSNotificationName const C8KSettingsChangedNotification = @"com.capture8k.settings-changed";
NSNotificationName const C8KCaptureRequestedNotification = @"com.capture8k.capture-requested";
NSNotificationName const C8KPrepareBrowserNotification = @"com.capture8k.prepare-browser";
NSNotificationName const C8KChooseFolderNotification = @"com.capture8k.choose-folder";

static NSArray<NSString *> *C8KArgumentsForProcess(pid_t processIdentifier) {
    int query[3] = { CTL_KERN, KERN_PROCARGS2, processIdentifier };
    size_t size = 0;
    if (sysctl(query, 3, NULL, &size, NULL, 0) != 0 || size <= sizeof(int)) return @[];
    NSMutableData *storage = [NSMutableData dataWithLength:size];
    if (sysctl(query, 3, storage.mutableBytes, &size, NULL, 0) != 0 || size <= sizeof(int)) return @[];
    const char *bytes = storage.bytes;
    const char *end = bytes + size;
    int argumentCount = 0;
    memcpy(&argumentCount, bytes, sizeof(argumentCount));
    if (argumentCount <= 0 || argumentCount > 4096) return @[];
    const char *cursor = bytes + sizeof(argumentCount);
    while (cursor < end && *cursor != '\0') cursor++;
    while (cursor < end && *cursor == '\0') cursor++;
    NSMutableArray<NSString *> *arguments = [NSMutableArray arrayWithCapacity:(NSUInteger)argumentCount];
    for (int index = 0; index < argumentCount && cursor < end; index++) {
        const char *start = cursor;
        while (cursor < end && *cursor != '\0') cursor++;
        if (cursor > start) {
            NSString *argument = [[NSString alloc] initWithBytes:start
                length:(NSUInteger)(cursor - start) encoding:NSUTF8StringEncoding];
            if (argument) [arguments addObject:argument];
        }
        while (cursor < end && *cursor == '\0') cursor++;
    }
    return arguments;
}

static BOOL C8KIsSupportedBrowser(NSRunningApplication *application) {
    NSString *identifier = application.bundleIdentifier.lowercaseString ?: @"";
    return [identifier isEqualToString:@"com.google.chrome"] ||
        [identifier isEqualToString:@"com.google.chrome.beta"] ||
        [identifier isEqualToString:@"com.google.chrome.canary"] ||
        [identifier isEqualToString:@"com.brave.browser"] ||
        [identifier isEqualToString:@"org.mozilla.firefox"] ||
        [identifier isEqualToString:@"org.mozilla.firefoxdeveloperedition"] ||
        [identifier isEqualToString:@"org.mozilla.nightly"];
}

static BOOL C8KIsFirefox(NSRunningApplication *application) {
    NSString *identifier = application.bundleIdentifier.lowercaseString ?: @"";
    return [identifier hasPrefix:@"org.mozilla.firefox"] ||
        [identifier isEqualToString:@"org.mozilla.nightly"];
}

static NSString *C8KBrowserSupportDirectory(NSString *bundleIdentifier) {
    NSString *identifier = bundleIdentifier.lowercaseString ?: @"";
    if ([identifier isEqualToString:@"com.google.chrome.beta"]) return @"Google/Chrome Beta";
    if ([identifier isEqualToString:@"com.google.chrome.canary"]) return @"Google/Chrome Canary";
    if ([identifier isEqualToString:@"com.brave.browser"]) return @"BraveSoftware/Brave-Browser";
    if ([identifier isEqualToString:@"com.google.chrome"]) return @"Google/Chrome";
    return nil;
}

static NSURL *C8KBrowserLocalStateURL(NSString *bundleIdentifier) {
    NSString *override = NSProcessInfo.processInfo.environment[@"CAPTURE8K_BROWSER_LOCAL_STATE_PATH"];
    if (override.length > 0) return [NSURL fileURLWithPath:override isDirectory:NO];
    NSString *relativeDirectory = C8KBrowserSupportDirectory(bundleIdentifier);
    if (!relativeDirectory) return nil;
    NSURL *support = [NSFileManager.defaultManager.homeDirectoryForCurrentUser
        URLByAppendingPathComponent:@"Library/Application Support" isDirectory:YES];
    return [[support URLByAppendingPathComponent:relativeDirectory isDirectory:YES]
        URLByAppendingPathComponent:@"Local State" isDirectory:NO];
}

static NSString *C8KLastUsedProfileDirectory(NSString *bundleIdentifier) {
    NSURL *url = C8KBrowserLocalStateURL(bundleIdentifier);
    NSData *data = url ? [NSData dataWithContentsOfURL:url] : nil;
    NSDictionary *root = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSString *directory = [root[@"profile"][@"last_used"] isKindOfClass:NSString.class]
        ? root[@"profile"][@"last_used"] : nil;
    if (directory.length == 0 || [directory containsString:@"/"] || [directory containsString:@"\\"]) return nil;
    return directory;
}

BOOL C8KPersistentCaptureModeConfigured(NSString *bundleIdentifier) {
    NSURL *url = C8KBrowserLocalStateURL(bundleIdentifier);
    NSData *data = url ? [NSData dataWithContentsOfURL:url] : nil;
    NSDictionary *root = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSArray *experiments = [root[@"browser"][@"enabled_labs_experiments"] isKindOfClass:NSArray.class]
        ? root[@"browser"][@"enabled_labs_experiments"] : @[];
    for (id value in experiments) {
        if ([value isKindOfClass:NSString.class] &&
            [(NSString *)value isEqualToString:@"silent-debugger-extension-api"]) return YES;
    }
    return NO;
}

BOOL C8KInstallPersistentCaptureMode(NSString *bundleIdentifier, NSError **error) {
    NSURL *url = C8KBrowserLocalStateURL(bundleIdentifier);
    if (!url) {
        if (error) *error = [NSError errorWithDomain:@"com.capture8k.app" code:40 userInfo:@{
            NSLocalizedDescriptionKey: @"Ce navigateur ne permet pas d’activer le mode Capture8K persistant."
        }];
        return NO;
    }
    NSData *data = [NSData dataWithContentsOfURL:url options:0 error:error];
    if (!data) return NO;
    NSMutableDictionary *root = [[NSJSONSerialization JSONObjectWithData:data
        options:NSJSONReadingMutableContainers error:error] mutableCopy];
    if (![root isKindOfClass:NSMutableDictionary.class]) return NO;

    NSMutableDictionary *browser = [root[@"browser"] isKindOfClass:NSDictionary.class]
        ? [root[@"browser"] mutableCopy] : [NSMutableDictionary dictionary];
    NSMutableArray *experiments = [browser[@"enabled_labs_experiments"] isKindOfClass:NSArray.class]
        ? [browser[@"enabled_labs_experiments"] mutableCopy] : [NSMutableArray array];
    NSIndexSet *obsoleteEntries = [experiments indexesOfObjectsPassingTest:
        ^BOOL(id value, NSUInteger index, BOOL *stop) {
            return [value isKindOfClass:NSString.class] &&
                [(NSString *)value hasPrefix:@"silent-debugger-extension-api"];
        }];
    if (obsoleteEntries.count > 0) [experiments removeObjectsAtIndexes:obsoleteEntries];
    // SINGLE_VALUE_TYPE flags are stored under their bare internal name.
    // The "@N" suffix is reserved for multi-choice flags; Chrome sanitizes it away here.
    [experiments addObject:@"silent-debugger-extension-api"];
    browser[@"enabled_labs_experiments"] = experiments;
    root[@"browser"] = browser;

    NSData *encoded = [NSJSONSerialization dataWithJSONObject:root options:0 error:error];
    return encoded && [encoded writeToURL:url options:NSDataWritingAtomic error:error];
}

static pid_t C8KParentProcessIdentifier(pid_t processIdentifier) {
    int query[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, processIdentifier };
    struct kinfo_proc information = { 0 };
    size_t size = sizeof(information);
    if (sysctl(query, 4, &information, &size, NULL, 0) != 0 || size == 0) return 0;
    return information.kp_eproc.e_ppid;
}

static NSDictionary *C8KStatusForBrowser(NSRunningApplication *browser) {
    NSArray<NSString *> *arguments = C8KArgumentsForProcess(browser.processIdentifier);
    BOOL firefox = C8KIsFirefox(browser);
    BOOL ready = firefox || [arguments containsObject:@"--silent-debugger-extension-api"];
    NSMutableDictionary *status = [@{
        @"running": @YES,
        @"captureModeReady": @(ready),
        @"browserName": browser.localizedName ?: @"Google Chrome",
        @"bundleIdentifier": browser.bundleIdentifier ?: @"com.google.Chrome",
        @"processIdentifier": @(browser.processIdentifier),
        @"applicationPath": browser.bundleURL.path ?: @"",
        @"persistentCaptureMode": @(firefox || C8KPersistentCaptureModeConfigured(browser.bundleIdentifier)),
        @"nativeScaleCapture": @(firefox)
    } mutableCopy];
    NSString *profileDirectory = firefox ? nil : C8KLastUsedProfileDirectory(browser.bundleIdentifier);
    if (profileDirectory) status[@"profileDirectory"] = profileDirectory;
    return status;
}

NSDictionary *C8KBrowserStatus(void) {
    pid_t ancestor = getppid();
    for (NSUInteger depth = 0; ancestor > 1 && depth < 12; depth++) {
        NSRunningApplication *application =
            [NSRunningApplication runningApplicationWithProcessIdentifier:ancestor];
        if (application && C8KIsSupportedBrowser(application)) return C8KStatusForBrowser(application);
        ancestor = C8KParentProcessIdentifier(ancestor);
    }

    NSArray<NSRunningApplication *> *running = NSWorkspace.sharedWorkspace.runningApplications;
    NSRunningApplication *browser = nil;
    NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (frontmost && C8KIsSupportedBrowser(frontmost)) browser = frontmost;
    for (NSRunningApplication *application in running) {
        if (!browser && [application.bundleIdentifier.lowercaseString isEqualToString:@"com.google.chrome"]) {
            browser = application;
            break;
        }
    }
    if (!browser) {
        for (NSRunningApplication *application in running) {
            if (C8KIsSupportedBrowser(application)) { browser = application; break; }
        }
    }
    if (!browser) {
        return @{ @"running": @NO, @"captureModeReady": @NO, @"browserName": @"Navigateur" };
    }
    return C8KStatusForBrowser(browser);
}

NSURL *C8KSettingsURL(void) {
    NSString *override = NSProcessInfo.processInfo.environment[@"CAPTURE8K_SETTINGS_PATH"];
    if (override.length > 0) return [NSURL fileURLWithPath:override];
    return [[NSFileManager.defaultManager.homeDirectoryForCurrentUser
        URLByAppendingPathComponent:@"Library/Application Support/Capture8K" isDirectory:YES]
        URLByAppendingPathComponent:@"settings.json"];
}

NSDictionary *C8KDefaultSettings(void) {
    NSString *downloads = [[NSFileManager.defaultManager.homeDirectoryForCurrentUser
        URLByAppendingPathComponent:@"Downloads/Capture8K" isDirectory:YES] path];
    return @{ @"resolution": @"8k", @"outputMode": @"downloads",
        @"outputDirectory": downloads, @"copyToClipboard": @YES, @"completionSound": @YES };
}

NSDictionary *C8KLoadSettings(void) {
    NSData *data = [NSData dataWithContentsOfURL:C8KSettingsURL()];
    NSDictionary *decoded = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![decoded isKindOfClass:NSDictionary.class]) return C8KDefaultSettings();
    NSMutableDictionary *settings = [C8KDefaultSettings() mutableCopy];
    NSString *resolution = decoded[@"resolution"];
    if ([resolution isEqualToString:@"4k"] || [resolution isEqualToString:@"8k"]) {
        settings[@"resolution"] = resolution;
    }
    NSString *directory = decoded[@"outputDirectory"];
    if ([directory isKindOfClass:NSString.class] && directory.length > 0) settings[@"outputDirectory"] = directory;
    NSString *outputMode = decoded[@"outputMode"];
    if ([@[ @"downloads", @"custom", @"premiere" ] containsObject:outputMode]) {
        settings[@"outputMode"] = outputMode;
    } else if ([directory isKindOfClass:NSString.class] && directory.length > 0) {
        settings[@"outputMode"] = @"custom";
    }
    NSNumber *clipboard = decoded[@"copyToClipboard"];
    if ([clipboard isKindOfClass:NSNumber.class]) settings[@"copyToClipboard"] = clipboard;
    NSNumber *sound = decoded[@"completionSound"];
    if ([sound isKindOfClass:NSNumber.class]) settings[@"completionSound"] = @([sound boolValue]);
    return settings;
}

BOOL C8KSaveSettings(NSDictionary *settings, NSError **error) {
    NSURL *url = C8KSettingsURL();
    if (![NSFileManager.defaultManager createDirectoryAtURL:url.URLByDeletingLastPathComponent
                                withIntermediateDirectories:YES attributes:nil error:error]) return NO;
    NSData *data = [NSJSONSerialization dataWithJSONObject:settings options:0 error:error];
    return data && [data writeToURL:url options:NSDataWritingAtomic error:error];
}

static NSArray<NSNumber *> *C8KVersionParts(NSString *version) {
    NSMutableArray<NSNumber *> *parts = [NSMutableArray array];
    for (NSString *part in [version componentsSeparatedByString:@"."]) {
        [parts addObject:@(MAX(0, part.integerValue))];
    }
    while (parts.count < 3) [parts addObject:@0];
    return parts;
}

static NSComparisonResult C8KCompareVersions(NSString *first, NSString *second) {
    NSArray<NSNumber *> *a = C8KVersionParts(first ?: @"0");
    NSArray<NSNumber *> *b = C8KVersionParts(second ?: @"0");
    for (NSUInteger index = 0; index < MAX(a.count, b.count); index++) {
        NSInteger left = index < a.count ? a[index].integerValue : 0;
        NSInteger right = index < b.count ? b[index].integerValue : 0;
        if (left < right) return NSOrderedAscending;
        if (left > right) return NSOrderedDescending;
    }
    return NSOrderedSame;
}

BOOL C8KInstallCreatorBridge(NSError **error) {
    NSURL *source = [NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"Creator Bridge" isDirectory:YES];
    NSData *sourceData = [NSData dataWithContentsOfURL:[source URLByAppendingPathComponent:@"manifest.json"]];
    NSDictionary *sourceManifest = sourceData
        ? [NSJSONSerialization JSONObjectWithData:sourceData options:0 error:nil] : nil;
    if (![sourceManifest[@"id"] isEqualToString:@"fr.clipflow.premiere.bridge"]) {
        if (error) *error = [NSError errorWithDomain:@"com.capture8k.app" code:60 userInfo:@{
            NSLocalizedDescriptionKey: @"Le composant Creator Bridge intégré est invalide."
        }];
        return NO;
    }
    NSString *sourceVersion = [sourceManifest[@"version"] isKindOfClass:NSString.class]
        ? sourceManifest[@"version"] : @"0";
    NSURL *root = [NSFileManager.defaultManager.homeDirectoryForCurrentUser
        URLByAppendingPathComponent:@"Library/Application Support/Adobe/UXP/Plugins/External" isDirectory:YES];
    if (![NSFileManager.defaultManager createDirectoryAtURL:root withIntermediateDirectories:YES
            attributes:nil error:error]) return NO;
    NSURL *target = [root URLByAppendingPathComponent:
        [NSString stringWithFormat:@"fr.clipflow.premiere.bridge_%@", sourceVersion] isDirectory:YES];
    NSString *newestInstalledVersion = @"0";
    NSMutableArray<NSURL *> *olderCopies = [NSMutableArray array];
    NSArray<NSURL *> *entries = [NSFileManager.defaultManager contentsOfDirectoryAtURL:root
        includingPropertiesForKeys:nil options:NSDirectoryEnumerationSkipsHiddenFiles error:nil] ?: @[];
    for (NSURL *entry in entries) {
        if (![entry.lastPathComponent hasPrefix:@"fr.clipflow.premiere.bridge_"]) continue;
        NSData *data = [NSData dataWithContentsOfURL:[entry URLByAppendingPathComponent:@"manifest.json"]];
        NSDictionary *manifest = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        if (![manifest[@"id"] isEqualToString:@"fr.clipflow.premiere.bridge"]) continue;
        NSString *version = [manifest[@"version"] isKindOfClass:NSString.class] ? manifest[@"version"] : @"0";
        if (C8KCompareVersions(version, newestInstalledVersion) == NSOrderedDescending) newestInstalledVersion = version;
        if (C8KCompareVersions(version, sourceVersion) == NSOrderedAscending) [olderCopies addObject:entry];
    }
    if (C8KCompareVersions(newestInstalledVersion, sourceVersion) == NSOrderedDescending) return YES;
    if (![NSFileManager.defaultManager fileExistsAtPath:target.path]) {
        NSURL *staged = [root URLByAppendingPathComponent:@".creator-bridge-new" isDirectory:YES];
        [NSFileManager.defaultManager removeItemAtURL:staged error:nil];
        if (![NSFileManager.defaultManager copyItemAtURL:source toURL:staged error:error]) return NO;
        if (![NSFileManager.defaultManager moveItemAtURL:staged toURL:target error:error]) {
            [NSFileManager.defaultManager removeItemAtURL:staged error:nil];
            return NO;
        }
    }
    for (NSURL *older in olderCopies) {
        if (![older.path isEqualToString:target.path]) [NSFileManager.defaultManager removeItemAtURL:older error:nil];
    }
    return YES;
}

NSString *C8KSanitizedFilename(NSString *filename) {
    NSString *leaf = filename.lastPathComponent;
    NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
        @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._-()"];
    NSMutableString *result = [NSMutableString string];
    for (NSUInteger index = 0; index < leaf.length; index++) {
        unichar character = [leaf characterAtIndex:index];
        [result appendString:[allowed characterIsMember:character]
            ? [NSString stringWithCharacters:&character length:1] : @"-"];
    }
    NSString *trimmed = [result stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return trimmed.length > 4 && [trimmed.lowercaseString hasSuffix:@".png"] ? trimmed : @"Capture8K.png";
}

NSURL *C8KUniqueDestination(NSURL *directory, NSString *filename) {
    NSString *safe = C8KSanitizedFilename(filename);
    NSString *stem = safe.stringByDeletingPathExtension;
    NSString *extension = safe.pathExtension;
    NSURL *candidate = [directory URLByAppendingPathComponent:safe];
    NSUInteger index = 2;
    while ([NSFileManager.defaultManager fileExistsAtPath:candidate.path]) {
        candidate = [directory URLByAppendingPathComponent:
            [NSString stringWithFormat:@"%@-%lu.%@", stem, (unsigned long)index++, extension]];
    }
    return candidate;
}
