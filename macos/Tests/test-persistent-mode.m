#import <Foundation/Foundation.h>
#import "Capture8KShared.h"

static void C8KRequire(BOOL condition, NSString *message) {
    if (condition) return;
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
}

int main(void) {
    @autoreleasepool {
        NSURL *directory = [[NSURL fileURLWithPath:NSTemporaryDirectory() isDirectory:YES]
            URLByAppendingPathComponent:NSUUID.UUID.UUIDString isDirectory:YES];
        C8KRequire([NSFileManager.defaultManager createDirectoryAtURL:directory
            withIntermediateDirectories:YES attributes:nil error:nil], @"Impossible de créer le dossier de test.");
        NSURL *localState = [directory URLByAppendingPathComponent:@"Local State"];
        NSDictionary *fixture = @{
            @"browser": @{ @"enabled_labs_experiments": @[
                @"existing-flag@1", @"silent-debugger-extension-api@2"
            ] },
            @"unrelated": @{ @"preserved": @YES }
        };
        NSData *fixtureData = [NSJSONSerialization dataWithJSONObject:fixture options:0 error:nil];
        C8KRequire([fixtureData writeToURL:localState atomically:YES], @"Impossible d’écrire le témoin.");
        setenv("CAPTURE8K_BROWSER_LOCAL_STATE_PATH", localState.path.UTF8String, 1);

        C8KRequire(!C8KPersistentCaptureModeConfigured(@"com.google.Chrome"),
            @"Un réglage désactivé ne doit pas être accepté.");
        NSError *error = nil;
        C8KRequire(C8KInstallPersistentCaptureMode(@"com.google.Chrome", &error),
            error.localizedDescription ?: @"L’activation persistante a échoué.");
        C8KRequire(C8KPersistentCaptureModeConfigured(@"com.google.Chrome"),
            @"Le réglage persistant n’a pas été détecté après écriture.");

        NSData *resultData = [NSData dataWithContentsOfURL:localState];
        NSDictionary *result = [NSJSONSerialization JSONObjectWithData:resultData options:0 error:nil];
        NSArray *experiments = result[@"browser"][@"enabled_labs_experiments"];
        C8KRequire([experiments containsObject:@"existing-flag@1"], @"Un autre réglage Chrome a été perdu.");
        C8KRequire([experiments containsObject:@"silent-debugger-extension-api@1"],
            @"Le mode Capture8K n’a pas été activé.");
        C8KRequire(![experiments containsObject:@"silent-debugger-extension-api@2"],
            @"L’ancien réglage désactivé n’a pas été remplacé.");
        C8KRequire([result[@"unrelated"][@"preserved"] boolValue], @"Une donnée étrangère a été modifiée.");
        [NSFileManager.defaultManager removeItemAtURL:directory error:nil];
        puts("Mode Chrome persistant : OK");
    }
    return 0;
}
