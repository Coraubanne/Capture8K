#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#include <math.h>
#include <string.h>
#import "Capture8KShared.h"

static NSLock *C8KProtocolLock(void) {
    static NSLock *lock;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{ lock = [NSLock new]; });
    return lock;
}

static void C8KWriteMessage(NSDictionary *object) {
    if (![NSJSONSerialization isValidJSONObject:object]) return;
    NSData *payload = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
    if (!payload) return;
    uint32_t length = CFSwapInt32HostToLittle((uint32_t)payload.length);
    NSData *header = [NSData dataWithBytes:&length length:sizeof(length)];
    [C8KProtocolLock() lock];
    NSFileHandle *output = [NSFileHandle fileHandleWithStandardOutput];
    [output writeData:header];
    [output writeData:payload];
    @try { [output synchronizeFile]; } @catch (__unused NSException *exception) {}
    [C8KProtocolLock() unlock];
}

static NSData *C8KReadExactly(NSUInteger count) {
    NSMutableData *result = [NSMutableData dataWithCapacity:count];
    while (result.length < count) {
        NSData *part = [[NSFileHandle fileHandleWithStandardInput] readDataOfLength:count - result.length];
        if (part.length == 0) return nil;
        [result appendData:part];
    }
    return result;
}

static NSDictionary *C8KReadMessage(void) {
    NSData *header = C8KReadExactly(4);
    if (!header) return nil;
    uint32_t rawLength = 0;
    [header getBytes:&rawLength length:sizeof(rawLength)];
    uint32_t length = CFSwapInt32LittleToHost(rawLength);
    if (length == 0 || length > 64 * 1024 * 1024) return nil;
    NSData *payload = C8KReadExactly(length);
    id object = payload ? [NSJSONSerialization JSONObjectWithData:payload options:0 error:nil] : nil;
    return [object isKindOfClass:NSDictionary.class] ? object : nil;
}

static NSError *C8KError(NSInteger code, NSString *message) {
    return [NSError errorWithDomain:@"com.capture8k.native" code:code
        userInfo:@{ NSLocalizedDescriptionKey: message }];
}

static NSArray<NSNumber *> *C8KSemanticVersion(NSString *value) {
    NSString *clean = [value hasPrefix:@"v"] ? [value substringFromIndex:1] : value;
    NSArray<NSString *> *raw = [clean componentsSeparatedByString:@"."];
    if (raw.count != 3) return nil;
    NSMutableArray<NSNumber *> *result = [NSMutableArray array];
    NSCharacterSet *invalid = NSCharacterSet.decimalDigitCharacterSet.invertedSet;
    for (NSString *part in raw) {
        if (part.length == 0 || [part rangeOfCharacterFromSet:invalid].location != NSNotFound) return nil;
        [result addObject:@(part.integerValue)];
    }
    return result;
}

static NSComparisonResult C8KCompareSemanticVersions(NSString *first, NSString *second) {
    NSArray<NSNumber *> *a = C8KSemanticVersion(first);
    NSArray<NSNumber *> *b = C8KSemanticVersion(second);
    if (!a || !b) return NSOrderedSame;
    for (NSUInteger index = 0; index < 3; index++) {
        if (a[index].integerValue < b[index].integerValue) return NSOrderedAscending;
        if (a[index].integerValue > b[index].integerValue) return NSOrderedDescending;
    }
    return NSOrderedSame;
}

static NSDictionary *C8KCheckUpdate(NSError **error) {
    NSURL *url = [NSURL URLWithString:@"https://api.github.com/repos/Coraubanne/Capture8K/releases/latest"];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:12.0];
    [request setValue:@"application/vnd.github+json" forHTTPHeaderField:@"Accept"];
    [request setValue:@"Capture8K/2.8.0" forHTTPHeaderField:@"User-Agent"];
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block NSData *responseData = nil;
    __block NSError *requestError = nil;
    __block NSInteger statusCode = 0;
    [[[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *taskError) {
        responseData = data; requestError = taskError;
        if ([response isKindOfClass:NSHTTPURLResponse.class]) statusCode = ((NSHTTPURLResponse *)response).statusCode;
        dispatch_semaphore_signal(semaphore);
    }] resume];
    dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 13 * NSEC_PER_SEC));
    NSString *current = NSBundle.mainBundle.infoDictionary[@"CFBundleShortVersionString"] ?: @"2.8.0";
    if (!requestError && statusCode == 404) {
        return @{ @"type": @"update-status", @"ok": @YES, @"currentVersion": current,
            @"latestVersion": current, @"updateAvailable": @NO,
            @"releaseURL": @"https://github.com/Coraubanne/Capture8K/releases" };
    }
    if (requestError || !responseData || statusCode != 200) {
        if (error) *error = C8KError(70, @"Impossible de joindre la release sécurisée sur GitHub.");
        return nil;
    }
    NSDictionary *release = [NSJSONSerialization JSONObjectWithData:responseData options:0 error:error];
    NSString *tag = [release[@"tag_name"] isKindOfClass:NSString.class] ? release[@"tag_name"] : nil;
    if (!C8KSemanticVersion(tag)) {
        if (error) *error = C8KError(71, @"La version publiée sur GitHub est invalide.");
        return nil;
    }
    NSString *latest = [tag hasPrefix:@"v"] ? [tag substringFromIndex:1] : tag;
    BOOL available = C8KCompareSemanticVersions(tag, current) == NSOrderedDescending;
    NSString *archiveName = [NSString stringWithFormat:@"Capture8K-complet-v%@.zip", latest];
    NSString *checksumName = [archiveName stringByAppendingString:@".sha256"];
    NSString *archiveURL = @"";
    NSString *checksumURL = @"";
    for (NSDictionary *asset in [release[@"assets"] isKindOfClass:NSArray.class] ? release[@"assets"] : @[]) {
        NSString *name = asset[@"name"];
        NSString *download = asset[@"browser_download_url"];
        if ([name isEqualToString:archiveName] && [download isKindOfClass:NSString.class]) archiveURL = download;
        if ([name isEqualToString:checksumName] && [download isKindOfClass:NSString.class]) checksumURL = download;
    }
    if (available && (archiveURL.length == 0 || checksumURL.length == 0)) {
        if (error) *error = C8KError(72, @"La release Capture8K est incomplète ; installation annulée.");
        return nil;
    }
    return @{ @"type": @"update-status", @"ok": @YES, @"currentVersion": current,
        @"latestVersion": latest, @"updateAvailable": @(available),
        @"archiveURL": archiveURL, @"checksumURL": checksumURL,
        @"releaseURL": release[@"html_url"] ?: @"https://github.com/Coraubanne/Capture8K/releases/latest" };
}

static NSArray<NSString *> *C8KInstalledChromeExtensionPaths(void) {
    NSURL *chrome = [NSFileManager.defaultManager.homeDirectoryForCurrentUser
        URLByAppendingPathComponent:@"Library/Application Support/Google/Chrome" isDirectory:YES];
    NSMutableOrderedSet<NSString *> *paths = [NSMutableOrderedSet orderedSet];
    for (NSURL *profile in [NSFileManager.defaultManager contentsOfDirectoryAtURL:chrome
            includingPropertiesForKeys:nil options:NSDirectoryEnumerationSkipsHiddenFiles error:nil] ?: @[]) {
        NSData *data = [NSData dataWithContentsOfURL:[profile URLByAppendingPathComponent:@"Secure Preferences"]];
        NSDictionary *preferences = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        NSDictionary *settings = preferences[@"extensions"][@"settings"];
        if (![settings isKindOfClass:NSDictionary.class]) continue;
        for (NSDictionary *entry in settings.allValues) {
            NSString *path = [entry[@"path"] isKindOfClass:NSString.class] ? entry[@"path"] : nil;
            NSData *manifestData = path.length > 0 ? [NSData dataWithContentsOfFile:[path stringByAppendingPathComponent:@"manifest.json"]] : nil;
            NSDictionary *manifest = manifestData ? [NSJSONSerialization JSONObjectWithData:manifestData options:0 error:nil] : nil;
            NSString *name = [manifest[@"name"] isKindOfClass:NSString.class] ? manifest[@"name"] : @"";
            if ([name hasPrefix:@"Capture8K"] && [path hasPrefix:NSHomeDirectory()]) [paths addObject:path];
        }
    }
    return paths.array;
}

static NSDictionary *C8KInstallUpdate(NSDictionary *message, NSError **error) {
    NSString *version = message[@"version"];
    NSString *archiveURL = message[@"archiveURL"];
    NSString *checksumURL = message[@"checksumURL"];
    if (!C8KSemanticVersion(version) || ![archiveURL hasPrefix:@"https://"] || ![checksumURL hasPrefix:@"https://"]) {
        if (error) *error = C8KError(73, @"Paramètres de mise à jour invalides.");
        return nil;
    }
    NSURL *executable = [NSURL fileURLWithPath:NSProcessInfo.processInfo.arguments.firstObject].standardizedURL;
    NSURL *appURL = executable.URLByDeletingLastPathComponent.URLByDeletingLastPathComponent.URLByDeletingLastPathComponent;
    NSURL *helper = [NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"install-update.sh"];
    if (![NSFileManager.defaultManager isExecutableFileAtPath:helper.path]) {
        if (error) *error = C8KError(74, @"Le moteur de mise à jour Capture8K est absent.");
        return nil;
    }
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/bin/zsh"];
    task.arguments = @[ helper.path, version, archiveURL, checksumURL, appURL.path ];
    NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
    environment[@"CAPTURE8K_CHROME_TARGETS"] = [C8KInstalledChromeExtensionPaths() componentsJoinedByString:@"\n"];
    task.environment = environment;
    NSPipe *output = [NSPipe pipe];
    NSPipe *failure = [NSPipe pipe];
    task.standardOutput = output;
    task.standardError = failure;
    if (![task launchAndReturnError:error]) return nil;
    [task waitUntilExit];
    NSData *failureData = [failure.fileHandleForReading readDataToEndOfFile];
    if (task.terminationStatus != 0) {
        NSString *detail = [[NSString alloc] initWithData:failureData encoding:NSUTF8StringEncoding];
        if (error) *error = C8KError(75, detail.length > 0 ? detail : @"L’installation automatique a échoué.");
        return nil;
    }
    return @{ @"type": @"update-status", @"ok": @YES, @"installed": @YES,
        @"currentVersion": version, @"latestVersion": version, @"updateAvailable": @NO,
        @"message": @"Capture8K et Creator Bridge ont été mis à jour." };
}

static NSDictionary *C8KActivePremiereConnection(NSError **error) {
    NSURL *storage = [NSFileManager.defaultManager.homeDirectoryForCurrentUser
        URLByAppendingPathComponent:@"Library/Application Support/Adobe/UXP/PluginsStorage/PPRO" isDirectory:YES];
    NSMutableArray<NSURL *> *bridges = [NSMutableArray array];
    NSString *override = NSProcessInfo.processInfo.environment[@"CAPTURE8K_PREMIERE_BRIDGE_PATH"];
    if (override.length > 0) [bridges addObject:[NSURL fileURLWithPath:override isDirectory:YES]];
    for (NSURL *versionDirectory in [NSFileManager.defaultManager contentsOfDirectoryAtURL:storage
            includingPropertiesForKeys:nil options:NSDirectoryEnumerationSkipsHiddenFiles error:nil] ?: @[]) {
        NSURL *bridge = [versionDirectory URLByAppendingPathComponent:
            @"External/fr.clipflow.premiere.bridge/PluginData" isDirectory:YES];
        if ([NSFileManager.defaultManager fileExistsAtPath:bridge.path]) [bridges addObject:bridge];
    }
    NSURL *legacy = [NSFileManager.defaultManager.homeDirectoryForCurrentUser
        URLByAppendingPathComponent:@"Library/Application Support/ClipFlow/Premiere" isDirectory:YES];
    if ([NSFileManager.defaultManager fileExistsAtPath:legacy.path]) [bridges addObject:legacy];
    NSDictionary *bestState = nil;
    NSURL *bestBridge = nil;
    NSTimeInterval bestTimestamp = 0;
    for (NSURL *bridge in bridges) {
        NSData *data = [NSData dataWithContentsOfURL:[bridge URLByAppendingPathComponent:@"active-project.json"]];
        NSDictionary *state = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        NSTimeInterval timestamp = [state[@"updatedAt"] doubleValue];
        if ([state isKindOfClass:NSDictionary.class] && timestamp > bestTimestamp) {
            bestState = state; bestBridge = bridge; bestTimestamp = timestamp;
        }
    }
    if (!bestState || NSDate.date.timeIntervalSince1970 - bestTimestamp / 1000.0 > 15.0) {
        if (error) *error = C8KError(30,
            @"Ouvre un projet enregistré et le panneau Creator Bridge dans Premiere Pro.");
        return nil;
    }
    NSString *projectPath = [bestState[@"projectPath"] isKindOfClass:NSString.class]
        ? bestState[@"projectPath"] : nil;
    BOOL isProject = projectPath.length > 0 && [projectPath.pathExtension.lowercaseString isEqualToString:@"prproj"] &&
        [NSFileManager.defaultManager fileExistsAtPath:projectPath];
    if (!isProject) {
        if (error) *error = C8KError(31, @"Enregistre d’abord le projet Premiere Pro actif.");
        return nil;
    }
    return @{ @"projectPath": projectPath, @"bridgePath": bestBridge.path };
}

static NSURL *C8KCaptureDestination(NSDictionary *settings, NSDictionary **premiere, NSError **error) {
    NSString *mode = settings[@"outputMode"];
    if ([mode isEqualToString:@"premiere"]) {
        NSDictionary *connection = C8KActivePremiereConnection(error);
        if (!connection) return nil;
        NSURL *project = [NSURL fileURLWithPath:connection[@"projectPath"]];
        NSURL *directory = [project.URLByDeletingLastPathComponent
            URLByAppendingPathComponent:@"Captures Capture8K" isDirectory:YES];
        if (premiere) *premiere = connection;
        return directory;
    }
    if ([mode isEqualToString:@"downloads"]) {
        return [NSFileManager.defaultManager.homeDirectoryForCurrentUser
            URLByAppendingPathComponent:@"Downloads/Capture8K" isDirectory:YES];
    }
    NSString *path = settings[@"outputDirectory"];
    return path.length > 0 ? [NSURL fileURLWithPath:path isDirectory:YES] : nil;
}

static BOOL C8KQueuePremiereImport(NSURL *media, NSDictionary *connection, NSString *jobId, NSError **error) {
    NSURL *bridge = [NSURL fileURLWithPath:connection[@"bridgePath"] isDirectory:YES];
    NSURL *imports = [bridge URLByAppendingPathComponent:@"Imports" isDirectory:YES];
    NSURL *results = [bridge URLByAppendingPathComponent:@"Results" isDirectory:YES];
    if (![NSFileManager.defaultManager createDirectoryAtURL:imports withIntermediateDirectories:YES attributes:nil error:error] ||
        ![NSFileManager.defaultManager createDirectoryAtURL:results withIntermediateDirectories:YES attributes:nil error:error]) return NO;
    NSString *identifier = jobId.length > 0 ? jobId : NSUUID.UUID.UUIDString;
    NSDictionary *payload = @{
        @"schemaVersion": @1, @"jobId": identifier,
        @"producer": @"capture8k", @"producerName": @"Capture8K", @"kind": @"still",
        @"mediaPath": media.path, @"projectPath": connection[@"projectPath"],
        @"requestedAt": @((long long)(NSDate.date.timeIntervalSince1970 * 1000.0))
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:error];
    if (!data) return NO;
    NSURL *temporary = [imports URLByAppendingPathComponent:[NSString stringWithFormat:@".%@.tmp", identifier]];
    NSURL *target = [imports URLByAppendingPathComponent:[identifier stringByAppendingString:@".json"]];
    if (![data writeToURL:temporary options:NSDataWritingAtomic error:error]) return NO;
    [NSFileManager.defaultManager removeItemAtURL:target error:nil];
    return [NSFileManager.defaultManager moveItemAtURL:temporary toURL:target error:error];
}

static CGImageRef C8KLoadImage(NSURL *url, NSError **error) CF_RETURNS_RETAINED {
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    CGImageRef image = source ? CGImageSourceCreateImageAtIndex(source, 0, NULL) : NULL;
    if (source) CFRelease(source);
    if (!image && error) *error = C8KError(2, @"Le fichier reçu n’est pas un PNG décodable.");
    return image;
}

static NSData *C8KRaster(CGImageRef image, size_t width, size_t height, NSError **error) {
    NSMutableData *pixels = [NSMutableData dataWithLength:width * height * 4];
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(pixels.mutableBytes, width, height, 8, width * 4,
        colorSpace, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(colorSpace);
    if (!context) {
        if (error) *error = C8KError(3, @"Impossible de créer la surface de contrôle colorimétrique.");
        return nil;
    }
    CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
    CGContextSetRGBFillColor(context, 1, 1, 1, 1);
    CGContextFillRect(context, CGRectMake(0, 0, width, height));
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGContextRelease(context);
    return pixels;
}

static NSArray<NSDictionary *> *C8KSanitizeRegions(id value) {
    if (![value isKindOfClass:NSArray.class]) return @[];
    NSMutableArray<NSDictionary *> *regions = [NSMutableArray array];
    for (id item in (NSArray *)value) {
        if (regions.count >= 32) break;
        if (![item isKindOfClass:NSDictionary.class]) continue;
        NSDictionary *region = item;
        double x = [region[@"x"] doubleValue];
        double y = [region[@"y"] doubleValue];
        double width = [region[@"width"] doubleValue];
        double height = [region[@"height"] doubleValue];
        if (!isfinite(x) || !isfinite(y) || !isfinite(width) || !isfinite(height)) continue;
        x = MAX(0, MIN(1, x));
        y = MAX(0, MIN(1, y));
        double right = MAX(x, MIN(1, x + width));
        double bottom = MAX(y, MIN(1, y + height));
        if (right - x < 0.002 || bottom - y < 0.002) continue;
        [regions addObject:@{ @"x": @(x), @"y": @(y),
            @"width": @(right - x), @"height": @(bottom - y) }];
    }
    return regions;
}

static NSDictionary *C8KCompare(CGImageRef first, CGImageRef second,
    NSArray<NSDictionary *> *excludedRegions, NSError **error) {
    const NSUInteger width = 384;
    const NSUInteger height = 216;
    NSData *left = C8KRaster(first, width, height, error);
    NSData *right = C8KRaster(second, width, height, error);
    if (!left || !right) return nil;
    const uint8_t *a = left.bytes;
    const uint8_t *b = right.bytes;
    NSUInteger fullPixelCount = left.length / 4;
    NSMutableData *excludedData = [NSMutableData dataWithLength:fullPixelCount];
    uint8_t *excluded = excludedData.mutableBytes;
    for (NSDictionary *region in excludedRegions) {
        NSUInteger leftX = MIN(width, (NSUInteger)floor([region[@"x"] doubleValue] * width));
        NSUInteger topY = MIN(height, (NSUInteger)floor([region[@"y"] doubleValue] * height));
        NSUInteger rightX = MIN(width, (NSUInteger)ceil(
            ([region[@"x"] doubleValue] + [region[@"width"] doubleValue]) * width));
        NSUInteger bottomY = MIN(height, (NSUInteger)ceil(
            ([region[@"y"] doubleValue] + [region[@"height"] doubleValue]) * height));
        for (NSUInteger y = topY; y < bottomY; y++) {
            memset(excluded + y * width + leftX, 1, rightX - leftX);
        }
    }
    NSUInteger pixelCount = 0;
    unsigned long long total = 0;
    NSUInteger changed = 0;
    for (NSUInteger offset = 0; offset < left.length; offset += 4) {
        if (excluded[offset / 4]) continue;
        pixelCount++;
        int red = abs((int)a[offset] - (int)b[offset]);
        int green = abs((int)a[offset + 1] - (int)b[offset + 1]);
        int blue = abs((int)a[offset + 2] - (int)b[offset + 2]);
        total += red + green + blue;
        if (MAX(red, MAX(green, blue)) > 18) changed++;
    }
    NSMutableData *leftEdgesData = [NSMutableData dataWithLength:pixelCount];
    NSMutableData *rightEdgesData = [NSMutableData dataWithLength:pixelCount];
    uint8_t *leftEdges = leftEdgesData.mutableBytes;
    uint8_t *rightEdges = rightEdgesData.mutableBytes;
    NSUInteger leftEdgeCount = 0;
    NSUInteger rightEdgeCount = 0;
    for (NSUInteger y = 0; y + 1 < height; y++) {
        for (NSUInteger x = 0; x + 1 < width; x++) {
            NSUInteger pixel = y * width + x;
            if (excluded[pixel] || excluded[pixel + 1] || excluded[pixel + width]) continue;
            NSUInteger offset = pixel * 4;
            NSUInteger rightOffset = offset + 4;
            NSUInteger downOffset = offset + width * 4;
            int lumaA = (77 * a[offset] + 150 * a[offset + 1] + 29 * a[offset + 2]) >> 8;
            int lumaARight = (77 * a[rightOffset] + 150 * a[rightOffset + 1] + 29 * a[rightOffset + 2]) >> 8;
            int lumaADown = (77 * a[downOffset] + 150 * a[downOffset + 1] + 29 * a[downOffset + 2]) >> 8;
            int lumaB = (77 * b[offset] + 150 * b[offset + 1] + 29 * b[offset + 2]) >> 8;
            int lumaBRight = (77 * b[rightOffset] + 150 * b[rightOffset + 1] + 29 * b[rightOffset + 2]) >> 8;
            int lumaBDown = (77 * b[downOffset] + 150 * b[downOffset + 1] + 29 * b[downOffset + 2]) >> 8;
            if (MAX(abs(lumaA - lumaARight), abs(lumaA - lumaADown)) > 22) {
                leftEdges[pixel] = 1;
                leftEdgeCount++;
            }
            if (MAX(abs(lumaB - lumaBRight), abs(lumaB - lumaBDown)) > 22) {
                rightEdges[pixel] = 1;
                rightEdgeCount++;
            }
        }
    }
    NSUInteger unmatched = 0;
    for (NSUInteger y = 0; y < height; y++) {
        for (NSUInteger x = 0; x < width; x++) {
            NSUInteger pixel = y * width + x;
            for (NSUInteger side = 0; side < 2; side++) {
                uint8_t *sourceEdges = side == 0 ? leftEdges : rightEdges;
                uint8_t *targetEdges = side == 0 ? rightEdges : leftEdges;
                if (excluded[pixel] || !sourceEdges[pixel]) continue;
                BOOL matched = NO;
                NSInteger minimumY = MAX(0, (NSInteger)y - 1);
                NSInteger maximumY = MIN((NSInteger)height - 1, (NSInteger)y + 1);
                NSInteger minimumX = MAX(0, (NSInteger)x - 1);
                NSInteger maximumX = MIN((NSInteger)width - 1, (NSInteger)x + 1);
                for (NSInteger nearbyY = minimumY; nearbyY <= maximumY && !matched; nearbyY++) {
                    for (NSInteger nearbyX = minimumX; nearbyX <= maximumX; nearbyX++) {
                        NSUInteger nearbyPixel = (NSUInteger)nearbyY * width + (NSUInteger)nearbyX;
                        if (!excluded[nearbyPixel] && targetEdges[nearbyPixel]) { matched = YES; break; }
                    }
                }
                if (!matched) unmatched++;
            }
        }
    }
    NSUInteger combinedEdges = leftEdgeCount + rightEdgeCount;
    double edgeMismatch = combinedEdges ? (double)unmatched / (double)combinedEdges : 0;
    if (pixelCount < fullPixelCount * 0.4) {
        if (error) *error = C8KError(17, @"Les surfaces intégrées masquent une part trop importante de la page.");
        return nil;
    }
    return @{
        @"mean": @((double)total / (double)(pixelCount * 3 * 255)),
        @"changedRatio": @((double)changed / (double)pixelCount),
        @"edgeMismatch": @(edgeMismatch),
        @"edgeCount": @(combinedEdges),
        @"excludedRatio": @(1.0 - (double)pixelCount / (double)fullPixelCount)
    };
}

static BOOL C8KWriteComposite(CGImageRef reference, CGImageRef render,
    NSArray<NSDictionary *> *regions, NSURL *destination, NSError **error) {
    size_t width = CGImageGetWidth(render);
    size_t height = CGImageGetHeight(render);
    NSMutableData *pixels = [NSMutableData dataWithLength:width * height * 4];
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(pixels.mutableBytes, width, height, 8, width * 4,
        colorSpace, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(colorSpace);
    if (!context) {
        if (error) *error = C8KError(18, @"Impossible de créer la surface de composition fidèle.");
        return NO;
    }
    CGContextTranslateCTM(context, 0, height);
    CGContextScaleCTM(context, 1, -1);
    CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
    CGRect outputRect = CGRectMake(0, 0, width, height);
    CGContextDrawImage(context, outputRect, render);
    for (NSDictionary *region in regions) {
        CGRect clip = CGRectMake(
            [region[@"x"] doubleValue] * width,
            [region[@"y"] doubleValue] * height,
            [region[@"width"] doubleValue] * width,
            [region[@"height"] doubleValue] * height);
        CGContextSaveGState(context);
        CGContextClipToRect(context, clip);
        CGContextDrawImage(context, outputRect, reference);
        CGContextRestoreGState(context);
    }
    CGImageRef composited = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    if (!composited) {
        if (error) *error = C8KError(19, @"Impossible de finaliser la composition fidèle.");
        return NO;
    }
    CGImageDestinationRef writer = CGImageDestinationCreateWithURL(
        (__bridge CFURLRef)destination, CFSTR("public.png"), 1, NULL);
    if (writer) CGImageDestinationAddImage(writer, composited, NULL);
    BOOL written = writer && CGImageDestinationFinalize(writer);
    if (writer) CFRelease(writer);
    CGImageRelease(composited);
    if (!written && error) *error = C8KError(20, @"Impossible d’écrire le PNG composé.");
    return written;
}

@interface C8KCaptureJob : NSObject
@property NSString *identifier;
@property NSString *filename;
@property NSInteger expectedWidth;
@property NSInteger expectedHeight;
@property NSArray<NSDictionary *> *compositedRegions;
@property NSURL *temporaryDirectory;
@property NSMutableDictionary<NSString *, NSFileHandle *> *handles;
@property NSMutableDictionary<NSString *, NSURL *> *urls;
- (instancetype)initWithIdentifier:(NSString *)identifier filename:(NSString *)filename
    width:(NSInteger)width height:(NSInteger)height certificate:(NSDictionary *)certificate error:(NSError **)error;
- (BOOL)appendKind:(NSString *)kind base64:(NSString *)base64 error:(NSError **)error;
- (NSDictionary *)finish:(NSError **)error;
- (void)cleanup;
@end

@implementation C8KCaptureJob
- (instancetype)initWithIdentifier:(NSString *)identifier filename:(NSString *)filename
    width:(NSInteger)width height:(NSInteger)height certificate:(NSDictionary *)certificate error:(NSError **)error {
    self = [super init];
    if (!self) return nil;
    self.identifier = identifier;
    self.filename = filename;
    self.expectedWidth = width;
    self.expectedHeight = height;
    self.compositedRegions = [certificate[@"compositedSurfaceFallback"] boolValue]
        ? C8KSanitizeRegions(certificate[@"compositedRegions"]) : @[];
    self.handles = [NSMutableDictionary dictionary];
    self.urls = [NSMutableDictionary dictionary];
    self.temporaryDirectory = [NSFileManager.defaultManager.temporaryDirectory
        URLByAppendingPathComponent:[NSString stringWithFormat:@"Capture8K-%@", identifier] isDirectory:YES];
    if (![NSFileManager.defaultManager createDirectoryAtURL:self.temporaryDirectory
            withIntermediateDirectories:YES attributes:nil error:error]) return nil;
    for (NSString *kind in @[ @"reference", @"baseline", @"render" ]) {
        NSURL *url = [self.temporaryDirectory URLByAppendingPathComponent:[kind stringByAppendingString:@".png"]];
        [NSFileManager.defaultManager createFileAtPath:url.path contents:nil attributes:nil];
        NSFileHandle *handle = [NSFileHandle fileHandleForWritingToURL:url error:error];
        if (!handle) { [self cleanup]; return nil; }
        self.handles[kind] = handle;
        self.urls[kind] = url;
    }
    return self;
}

- (BOOL)appendKind:(NSString *)kind base64:(NSString *)base64 error:(NSError **)error {
    NSFileHandle *handle = self.handles[kind];
    NSData *data = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
    if (!handle || !data) {
        if (error) *error = C8KError(4, @"Un morceau de capture est invalide.");
        return NO;
    }
    @try { [handle writeData:data]; }
    @catch (NSException *exception) {
        if (error) *error = C8KError(5, exception.reason ?: @"Écriture temporaire impossible.");
        return NO;
    }
    return YES;
}

- (NSDictionary *)finish:(NSError **)error {
    for (NSFileHandle *handle in self.handles.allValues) {
        @try { [handle synchronizeFile]; [handle closeFile]; } @catch (__unused NSException *exception) {}
    }
    [self.handles removeAllObjects];
    NSURL *referenceURL = self.urls[@"reference"];
    NSURL *baselineURL = self.urls[@"baseline"];
    NSURL *renderURL = self.urls[@"render"];
    if (!referenceURL || !baselineURL || !renderURL) {
        if (error) *error = C8KError(6, @"La capture reçue est incomplète.");
        return nil;
    }
    CGImageRef reference = C8KLoadImage(referenceURL, error);
    CGImageRef baseline = C8KLoadImage(baselineURL, error);
    CGImageRef render = C8KLoadImage(renderURL, error);
    if (!reference || !baseline || !render) {
        if (reference) CGImageRelease(reference);
        if (baseline) CGImageRelease(baseline);
        if (render) CGImageRelease(render);
        return nil;
    }
    NSInteger renderWidth = (NSInteger)CGImageGetWidth(render);
    NSInteger renderHeight = (NSInteger)CGImageGetHeight(render);
    if (renderWidth != self.expectedWidth || renderHeight != self.expectedHeight) {
        if (error) *error = C8KError(7, [NSString stringWithFormat:
            @"Le navigateur a produit %ld × %ld au lieu de %ld × %ld.", (long)renderWidth,
            (long)renderHeight, (long)self.expectedWidth, (long)self.expectedHeight]);
        CGImageRelease(reference); CGImageRelease(baseline); CGImageRelease(render);
        return nil;
    }
    NSDictionary *mirror = C8KCompare(reference, baseline, self.compositedRegions, error);
    NSDictionary *high = C8KCompare(reference, render, self.compositedRegions, error);
    if (!mirror || !high) {
        CGImageRelease(reference); CGImageRelease(baseline); CGImageRelease(render);
        return nil;
    }
    double mirrorMean = [mirror[@"mean"] doubleValue];
    double mirrorChanged = [mirror[@"changedRatio"] doubleValue];
    double mirrorEdges = [mirror[@"edgeMismatch"] doubleValue];
    NSUInteger mirrorEdgeCount = [mirror[@"edgeCount"] unsignedIntegerValue];
    BOOL mirrorEdgesReliable = mirrorEdgeCount >= 200;
    // Les deux API de capture du navigateur peuvent rasteriser les mêmes
    // contours avec un anticrénelage légèrement différent, surtout à 150 %.
    // La moyenne et les contours restent les garde-fous structurels ; le ratio
    // binaire tolère donc jusqu'à 10 % de pixels faiblement différents.
    if (mirrorMean > 0.010 || mirrorChanged > 0.10 || (mirrorEdgesReliable && mirrorEdges > 0.25)) {
        if (error) *error = C8KError(8, [NSString stringWithFormat:
            @"La capture de contrôle diffère de la page visible (écart %.2f %%). Aucun faux 8K n’a été enregistré.", mirrorMean * 100]);
        CGImageRelease(reference); CGImageRelease(baseline); CGImageRelease(render);
        return nil;
    }
    double highMean = [high[@"mean"] doubleValue];
    double highChanged = [high[@"changedRatio"] doubleValue];
    double highEdges = [high[@"edgeMismatch"] doubleValue];
    NSUInteger highEdgeCount = [high[@"edgeCount"] unsignedIntegerValue];
    BOOL highEdgesReliable = highEdgeCount >= 200;
    if (highMean > 0.015 || highChanged > 0.10 || (highEdgesReliable && highEdges > 0.25)) {
        if (error) *error = C8KError(9, [NSString stringWithFormat:
            @"Le rendu haute définition ne correspond plus à la page visible (écart %.2f %%, contours %.2f ; témoin %.2f %% / %.2f).",
            highMean * 100, highEdges, mirrorMean * 100, mirrorEdges]);
        CGImageRelease(reference); CGImageRelease(baseline); CGImageRelease(render);
        return nil;
    }
    NSURL *finalURL = renderURL;
    if (self.compositedRegions.count > 0) {
        finalURL = [self.temporaryDirectory URLByAppendingPathComponent:@"composited.png"];
        if (!C8KWriteComposite(reference, render, self.compositedRegions, finalURL, error)) {
            CGImageRelease(reference); CGImageRelease(baseline); CGImageRelease(render);
            return nil;
        }
    }
    CGImageRelease(reference); CGImageRelease(baseline); CGImageRelease(render);
    NSDictionary *settings = C8KLoadSettings();
    NSDictionary *premiereConnection = nil;
    NSURL *outputDirectory = C8KCaptureDestination(settings, &premiereConnection, error);
    if (!outputDirectory) return nil;
    if (![NSFileManager.defaultManager createDirectoryAtURL:outputDirectory
            withIntermediateDirectories:YES attributes:nil error:error]) return nil;
    NSURL *destination = C8KUniqueDestination(outputDirectory, self.filename);
    if (![NSFileManager.defaultManager moveItemAtURL:finalURL toURL:destination error:error]) return nil;
    BOOL premiereQueued = NO;
    NSString *premiereWarning = @"";
    if (premiereConnection) {
        NSError *importError = nil;
        premiereQueued = C8KQueuePremiereImport(destination, premiereConnection, self.identifier, &importError);
        if (!premiereQueued) premiereWarning = importError.localizedDescription ?: @"Import Premiere Pro en attente.";
    }
    if ([settings[@"copyToClipboard"] boolValue]) {
        dispatch_sync(dispatch_get_main_queue(), ^{
            [NSPasteboard.generalPasteboard clearContents];
            [NSPasteboard.generalPasteboard writeObjects:@[ destination ]];
        });
    }
    return @{
        @"type": @"save-complete", @"jobId": self.identifier, @"ok": @YES,
        @"path": destination.path, @"width": @(renderWidth), @"height": @(renderHeight),
        @"premiereImportQueued": @(premiereQueued),
        @"premiereImportWarning": premiereWarning,
        @"mirrorMeanDifference": @(mirrorMean), @"mirrorChangedPixelRatio": @(mirrorChanged),
        @"mirrorEdgeMismatch": @(mirrorEdges), @"mirrorEdgeCount": @(mirrorEdgeCount),
        @"compositedSurfaceCount": @(self.compositedRegions.count),
        @"compositedSurfaceCoverage": mirror[@"excludedRatio"] ?: @0,
        @"renderMeanDifference": @(highMean), @"renderChangedPixelRatio": @(highChanged),
        @"renderEdgeMismatch": @(highEdges), @"renderEdgeCount": @(highEdgeCount)
    };
}

- (void)cleanup {
    for (NSFileHandle *handle in self.handles.allValues) {
        @try { [handle closeFile]; } @catch (__unused NSException *exception) {}
    }
    [self.handles removeAllObjects];
    if (self.temporaryDirectory) [NSFileManager.defaultManager removeItemAtURL:self.temporaryDirectory error:nil];
}
@end

@interface C8KNativeHost : NSObject
@property NSMutableDictionary<NSString *, C8KCaptureJob *> *jobs;
@property NSLock *jobsLock;
@end

@implementation C8KNativeHost
- (instancetype)init {
    self = [super init];
    if (self) { self.jobs = [NSMutableDictionary dictionary]; self.jobsLock = [NSLock new]; }
    return self;
}

- (NSDictionary *)settingsMessage:(NSString *)type {
    NSDictionary *settings = C8KLoadSettings();
    NSDictionary *browser = C8KBrowserStatus();
    return @{
        @"type": type, @"resolution": settings[@"resolution"],
        @"outputMode": settings[@"outputMode"],
        @"outputDirectory": settings[@"outputDirectory"],
        @"copyToClipboard": settings[@"copyToClipboard"],
        @"browserRunning": browser[@"running"],
        @"browserCaptureModeReady": browser[@"captureModeReady"],
        @"browserName": browser[@"browserName"]
    };
}

- (void)start {
    [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(captureRequested:)
        name:C8KCaptureRequestedNotification object:nil];
    [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(settingsChanged:)
        name:C8KSettingsChangedNotification object:nil];
    [NSThread detachNewThreadSelector:@selector(readLoop) toTarget:self withObject:nil];
    [NSRunLoop.currentRunLoop run];
}

- (void)captureRequested:(NSNotification *)notification {
    C8KWriteMessage(@{ @"type": @"capture-request", @"resolution": C8KLoadSettings()[@"resolution"] });
}

- (void)settingsChanged:(NSNotification *)notification {
    C8KWriteMessage([self settingsMessage:@"settings-changed"]);
}

- (void)readLoop {
    @autoreleasepool {
        NSDictionary *message;
        while ((message = C8KReadMessage())) {
            @autoreleasepool {
                NSError *error = nil;
                if (![self handleMessage:message error:&error]) {
                    NSString *jobId = [message[@"jobId"] isKindOfClass:NSString.class] ? message[@"jobId"] : @"";
                    C8KWriteMessage(@{ @"type": @"save-complete", @"jobId": jobId,
                        @"ok": @NO, @"error": error.localizedDescription ?: @"Erreur native inconnue." });
                    if (jobId.length) {
                        [self.jobsLock lock];
                        [self.jobs[jobId] cleanup];
                        [self.jobs removeObjectForKey:jobId];
                        [self.jobsLock unlock];
                    }
                }
            }
        }
    }
    exit(0);
}

- (BOOL)handleMessage:(NSDictionary *)message error:(NSError **)error {
    NSString *type = message[@"type"];
    if (![type isKindOfClass:NSString.class]) {
        if (error) *error = C8KError(10, @"Message natif sans type.");
        return NO;
    }
    if ([type isEqualToString:@"ping"] || [type isEqualToString:@"get-settings"]) {
        C8KWriteMessage([self settingsMessage:@"settings"]);
        return YES;
    }
    if ([type isEqualToString:@"set-settings"]) {
        NSMutableDictionary *settings = [C8KLoadSettings() mutableCopy];
        NSString *resolution = message[@"resolution"];
        if ([resolution isEqualToString:@"4k"] || [resolution isEqualToString:@"8k"]) settings[@"resolution"] = resolution;
        NSString *outputMode = message[@"outputMode"];
        if ([@[ @"downloads", @"custom", @"premiere" ] containsObject:outputMode]) {
            if ([outputMode isEqualToString:@"premiere"] && !C8KInstallCreatorBridge(error)) return NO;
            settings[@"outputMode"] = outputMode;
        }
        if ([message[@"copyToClipboard"] isKindOfClass:NSNumber.class]) settings[@"copyToClipboard"] = message[@"copyToClipboard"];
        BOOL saved = C8KSaveSettings(settings, error);
        if (saved) C8KWriteMessage([self settingsMessage:@"settings-changed"]);
        return saved;
    }
    if ([type isEqualToString:@"check-update"]) {
        NSError *updateError = nil;
        NSDictionary *status = C8KCheckUpdate(&updateError);
        if (!status) {
            C8KWriteMessage(@{ @"type": @"update-status", @"ok": @NO,
                @"error": updateError.localizedDescription ?: @"La vérification a échoué." });
            return YES;
        }
        C8KWriteMessage(status);
        return YES;
    }
    if ([type isEqualToString:@"install-update"]) {
        NSError *updateError = nil;
        NSDictionary *status = C8KInstallUpdate(message, &updateError);
        C8KWriteMessage(status ?: @{ @"type": @"update-status", @"ok": @NO,
            @"error": updateError.localizedDescription ?: @"L’installation a échoué." });
        return YES;
    }
    if ([type isEqualToString:@"open-app"]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            NSURL *executable = [NSURL fileURLWithPath:NSProcessInfo.processInfo.arguments.firstObject].standardizedURL;
            NSURL *appURL = executable.URLByDeletingLastPathComponent.URLByDeletingLastPathComponent.URLByDeletingLastPathComponent;
            [NSWorkspace.sharedWorkspace openApplicationAtURL:appURL
                configuration:[NSWorkspaceOpenConfiguration configuration] completionHandler:nil];
        });
        C8KWriteMessage(@{ @"type": @"app-opened", @"ok": @YES });
        return YES;
    }
    if ([type isEqualToString:@"prepare-browser"]) {
        NSURL *hostExecutable = [NSURL fileURLWithPath:NSProcessInfo.processInfo.arguments.firstObject].standardizedURL;
        NSURL *appURL = hostExecutable.URLByDeletingLastPathComponent.URLByDeletingLastPathComponent.URLByDeletingLastPathComponent;
        NSURL *appExecutable = [appURL URLByAppendingPathComponent:@"Contents/MacOS/Capture8K"];
        NSError *launchError = nil;
        NSTask *task = [NSTask launchedTaskWithExecutableURL:appExecutable
            arguments:@[ @"--prepare-browser-direct" ] error:&launchError terminationHandler:nil];
        if (!task) {
            if (error) *error = launchError ?: C8KError(12, @"Le préparateur Chrome n’a pas pu démarrer.");
            return NO;
        }
        C8KWriteMessage(@{ @"type": @"browser-preparation-opened", @"ok": @YES });
        return YES;
    }
    if ([type isEqualToString:@"choose-folder"]) {
        NSArray<NSRunningApplication *> *runningApps =
            [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.capture8k.app"];
        if (runningApps.count > 0) {
            [NSDistributedNotificationCenter.defaultCenter postNotificationName:C8KChooseFolderNotification
                object:nil userInfo:nil deliverImmediately:YES];
        } else {
            NSURL *executable = [NSURL fileURLWithPath:NSProcessInfo.processInfo.arguments.firstObject].standardizedURL;
            NSURL *appURL = executable.URLByDeletingLastPathComponent.URLByDeletingLastPathComponent.URLByDeletingLastPathComponent;
            [NSWorkspace.sharedWorkspace openApplicationAtURL:appURL
                configuration:[NSWorkspaceOpenConfiguration configuration]
                completionHandler:^(__unused NSRunningApplication *application, __unused NSError *launchError) {
                    [NSDistributedNotificationCenter.defaultCenter postNotificationName:C8KChooseFolderNotification
                        object:nil userInfo:nil deliverImmediately:YES];
                }];
        }
        C8KWriteMessage(@{ @"type": @"folder-picker-opened", @"ok": @YES });
        return YES;
    }
    NSString *jobId = message[@"jobId"];
    if (![jobId isKindOfClass:NSString.class] || jobId.length == 0) {
        if (error) *error = C8KError(11, @"Identifiant de capture absent.");
        return NO;
    }
    if ([type isEqualToString:@"save-begin"]) {
        NSString *filename = message[@"filename"];
        NSNumber *width = message[@"expectedWidth"];
        NSNumber *height = message[@"expectedHeight"];
        if (![filename isKindOfClass:NSString.class] || ![width isKindOfClass:NSNumber.class] || ![height isKindOfClass:NSNumber.class]) {
            if (error) *error = C8KError(12, @"Paramètres de capture incomplets.");
            return NO;
        }
        NSDictionary *certificate = [message[@"certificate"] isKindOfClass:NSDictionary.class]
            ? message[@"certificate"] : @{};
        C8KCaptureJob *job = [[C8KCaptureJob alloc] initWithIdentifier:jobId filename:filename
            width:width.integerValue height:height.integerValue certificate:certificate error:error];
        if (!job) return NO;
        [self.jobsLock lock];
        [self.jobs[jobId] cleanup];
        self.jobs[jobId] = job;
        [self.jobsLock unlock];
        C8KWriteMessage(@{ @"type": @"save-ready", @"jobId": jobId, @"ok": @YES });
        return YES;
    }
    [self.jobsLock lock];
    C8KCaptureJob *job = self.jobs[jobId];
    [self.jobsLock unlock];
    if (!job) {
        if (error) *error = C8KError(13, @"Capture inconnue ou expirée.");
        return NO;
    }
    if ([type isEqualToString:@"save-chunk"]) {
        NSString *kind = message[@"kind"];
        NSString *data = message[@"data"];
        if (![data isKindOfClass:NSString.class] || ![@[ @"reference", @"baseline", @"render" ] containsObject:kind]) {
            if (error) *error = C8KError(14, @"Morceau de capture incomplet.");
            return NO;
        }
        return [job appendKind:kind base64:data error:error];
    }
    if ([type isEqualToString:@"save-end"]) {
        [self.jobsLock lock];
        [self.jobs removeObjectForKey:jobId];
        [self.jobsLock unlock];
        NSDictionary *response = [job finish:error];
        BOOL keepFailed = [NSProcessInfo.processInfo.environment[@"CAPTURE8K_KEEP_FAILED"] boolValue];
        if (!response && keepFailed) {
            NSString *original = (error && *error) ? (*error).localizedDescription : @"Échec de validation.";
            if (error) *error = C8KError(16, [NSString stringWithFormat:@"%@ Diagnostic : %@", original, job.temporaryDirectory.path]);
        } else {
            [job cleanup];
        }
        if (!response) return NO;
        C8KWriteMessage(response);
        return YES;
    }
    if ([type isEqualToString:@"save-cancel"]) {
        [self.jobsLock lock];
        [job cleanup];
        [self.jobs removeObjectForKey:jobId];
        [self.jobsLock unlock];
        return YES;
    }
    if (error) *error = C8KError(15, [NSString stringWithFormat:@"Commande native inconnue : %@.", type]);
    return NO;
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        C8KNativeHost *host = [C8KNativeHost new];
        [host start];
    }
    return 0;
}
