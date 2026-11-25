#import <AppKit/AppKit.h>
#import "Capture8KShared.h"

static NSArray<NSString *> *C8KChromeLaunchArguments(NSDictionary *status) {
    NSMutableArray<NSString *> *arguments = [NSMutableArray arrayWithObject:@"--silent-debugger-extension-api"];
    NSString *profileDirectory = [status[@"profileDirectory"] isKindOfClass:NSString.class]
        ? status[@"profileDirectory"] : nil;
    if (profileDirectory.length > 0) {
        [arguments addObject:[NSString stringWithFormat:@"--profile-directory=%@", profileDirectory]];
    }
    [arguments addObject:@"--restore-last-session"];
    return arguments;
}

static int C8KPrepareBrowserDirectly(void) {
    NSDictionary *status = C8KBrowserStatus();
    NSString *applicationPath = status[@"applicationPath"];
    NSURL *applicationURL = applicationPath.length > 0
        ? [NSURL fileURLWithPath:applicationPath isDirectory:YES]
        : [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:@"com.google.Chrome"];
    if (!applicationURL) return 2;

    NSNumber *processIdentifier = status[@"processIdentifier"];
    NSRunningApplication *browser = processIdentifier
        ? [NSRunningApplication runningApplicationWithProcessIdentifier:processIdentifier.intValue] : nil;
    if (browser && ![browser terminate]) return 3;

    NSDate *terminationDeadline = [NSDate dateWithTimeIntervalSinceNow:10.0];
    while (browser && !browser.terminated && terminationDeadline.timeIntervalSinceNow > 0) {
        [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    if (browser && !browser.terminated) return 4;

    NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
    configuration.arguments = C8KChromeLaunchArguments(status);
    configuration.activates = YES;

    __block BOOL launchFinished = NO;
    __block NSError *launchError = nil;
    [NSWorkspace.sharedWorkspace openApplicationAtURL:applicationURL configuration:configuration
        completionHandler:^(__unused NSRunningApplication *application, NSError *error) {
            launchError = error;
            launchFinished = YES;
        }];
    NSDate *launchDeadline = [NSDate dateWithTimeIntervalSinceNow:10.0];
    while (!launchFinished && launchDeadline.timeIntervalSinceNow > 0) {
        [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return launchFinished && !launchError ? 0 : 5;
}

@interface Capture8KApplicationDelegate : NSObject <NSApplicationDelegate>
@property NSStatusItem *statusItem;
@property NSMenuItem *resolution4KItem;
@property NSMenuItem *resolution8KItem;
@property NSMenuItem *folderItem;
@property NSMenuItem *browserStatusItem;
@property NSMenuItem *prepareBrowserItem;
@property NSTimer *statusTimer;
@property BOOL preparingBrowser;
@property BOOL folderPanelVisible;
@property NSDate *nextAutomaticPrepareAt;
- (void)requestCapture:(id)sender;
@end

@implementation Capture8KApplicationDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    C8KSaveSettings(C8KLoadSettings(), nil);
    C8KInstallCreatorBridge(nil);
    [NSDistributedNotificationCenter.defaultCenter addObserver:self
        selector:@selector(prepareBrowserRequested:) name:C8KPrepareBrowserNotification object:nil];
    [NSDistributedNotificationCenter.defaultCenter addObserver:self
        selector:@selector(chooseFolderRequested:) name:C8KChooseFolderNotification object:nil];
    [self buildMenu];
    self.statusTimer = [NSTimer scheduledTimerWithTimeInterval:2.0 target:self
        selector:@selector(refreshBrowserStatus:) userInfo:nil repeats:YES];
}

- (void)application:(NSApplication *)application openURLs:(NSArray<NSURL *> *)urls {
    for (NSURL *url in urls) {
        if ([url.scheme.lowercaseString isEqualToString:@"capture8k"] &&
            [url.host.lowercaseString isEqualToString:@"choose-folder"]) {
            dispatch_async(dispatch_get_main_queue(), ^{ [self chooseFolder:nil]; });
            return;
        }
    }
}

- (void)buildMenu {
    self.statusItem = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
    self.statusItem.button.title = @"8K";
    self.statusItem.button.toolTip = @"Capture8K";
    NSMenu *menu = [NSMenu new];
    self.browserStatusItem = [[NSMenuItem alloc] initWithTitle:@"Chrome : vérification…" action:nil keyEquivalent:@""];
    self.browserStatusItem.enabled = NO;
    [menu addItem:self.browserStatusItem];
    self.prepareBrowserItem = [[NSMenuItem alloc] initWithTitle:@"Préparer Chrome pour Capture8K…"
        action:@selector(prepareBrowser:) keyEquivalent:@""];
    self.prepareBrowserItem.target = self;
    [menu addItem:self.prepareBrowserItem];
    [menu addItem:NSMenuItem.separatorItem];
    self.resolution4KItem = [[NSMenuItem alloc] initWithTitle:@"Rendu 4K" action:@selector(select4K:) keyEquivalent:@""];
    self.resolution4KItem.target = self;
    [menu addItem:self.resolution4KItem];
    self.resolution8KItem = [[NSMenuItem alloc] initWithTitle:@"Rendu 8K" action:@selector(select8K:) keyEquivalent:@""];
    self.resolution8KItem.target = self;
    [menu addItem:self.resolution8KItem];
    [menu addItem:NSMenuItem.separatorItem];
    NSMenuItem *chooseFolder = [[NSMenuItem alloc] initWithTitle:@"Choisir le dossier…" action:@selector(chooseFolder:) keyEquivalent:@""];
    chooseFolder.target = self;
    [menu addItem:chooseFolder];
    self.folderItem = [[NSMenuItem alloc] initWithTitle:@"Afficher le dossier" action:@selector(revealFolder:) keyEquivalent:@""];
    self.folderItem.target = self;
    [menu addItem:self.folderItem];
    [menu addItem:NSMenuItem.separatorItem];
    NSMenuItem *about = [[NSMenuItem alloc] initWithTitle:@"À propos de Capture8K" action:@selector(showAbout:) keyEquivalent:@""];
    about.target = self;
    [menu addItem:about];
    [menu addItem:[[NSMenuItem alloc] initWithTitle:@"Quitter Capture8K" action:@selector(terminate:) keyEquivalent:@"q"]];
    self.statusItem.menu = menu;
    [self refreshMenu];
}

- (void)refreshMenu {
    NSDictionary *settings = C8KLoadSettings();
    BOOL is4K = [settings[@"resolution"] isEqualToString:@"4k"];
    self.resolution4KItem.state = is4K ? NSControlStateValueOn : NSControlStateValueOff;
    self.resolution8KItem.state = is4K ? NSControlStateValueOff : NSControlStateValueOn;
    self.folderItem.toolTip = settings[@"outputDirectory"];
    NSDictionary *browser = C8KBrowserStatus();
    BOOL running = [browser[@"running"] boolValue];
    BOOL ready = [browser[@"captureModeReady"] boolValue];
    NSString *browserName = browser[@"browserName"] ?: @"Google Chrome";
    NSString *identifier = [browser[@"bundleIdentifier"] lowercaseString] ?: @"";
    BOOL firefox = [identifier hasPrefix:@"org.mozilla.firefox"] ||
        [identifier isEqualToString:@"org.mozilla.nightly"];
    self.browserStatusItem.title = firefox
        ? [NSString stringWithFormat:@"%@ : moteur 4K/8K natif prêt", browserName]
        : (ready ? [NSString stringWithFormat:@"%@ : mode fidèle actif", browserName]
                 : (running ? [NSString stringWithFormat:@"%@ : correction automatique…", browserName]
                            : @"Navigateur : fermé"));
    self.prepareBrowserItem.title = firefox
        ? @"Firefox ne nécessite aucune préparation"
        : (ready ? @"Recharger Capture8K dans Chrome…"
                 : (running ? @"Corriger Chrome maintenant…" : @"Ouvrir Chrome en mode Capture8K"));
    self.prepareBrowserItem.enabled = !firefox && !self.preparingBrowser;
    self.statusItem.button.title = [NSString stringWithFormat:@"%@%@", is4K ? @"4K" : @"8K", ready ? @"" : @"!"];
    self.statusItem.button.toolTip = firefox
        ? @"Capture8K — Firefox prêt"
        : (ready ? @"Capture8K — Chrome prêt" : @"Capture8K — préparer Chrome");

    BOOL automaticPreparationAllowed = !self.nextAutomaticPrepareAt ||
        self.nextAutomaticPrepareAt.timeIntervalSinceNow <= 0;
    if (!firefox && running && !ready && !self.preparingBrowser && automaticPreparationAllowed) {
        // Chrome ne sait pas conserver ce commutateur entre deux lancements.
        // L'agent Capture8K le réapplique donc automatiquement et limite les
        // nouvelles tentatives si Chrome refuse momentanément de se fermer.
        self.nextAutomaticPrepareAt = [NSDate dateWithTimeIntervalSinceNow:30.0];
        dispatch_async(dispatch_get_main_queue(), ^{ [self prepareBrowserRequiringConfirmation:NO]; });
    }
}

- (void)refreshBrowserStatus:(id)sender { [self refreshMenu]; }

- (void)prepareBrowserRequested:(NSNotification *)notification {
    dispatch_async(dispatch_get_main_queue(), ^{ [self prepareBrowserRequiringConfirmation:NO]; });
}

- (void)chooseFolderRequested:(NSNotification *)notification {
    dispatch_async(dispatch_get_main_queue(), ^{ [self chooseFolder:nil]; });
}

- (void)showBrowserError:(NSString *)message {
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"Impossible de préparer Chrome";
    alert.informativeText = message ?: @"Une erreur inconnue est survenue.";
    [alert addButtonWithTitle:@"OK"];
    [NSApp activateIgnoringOtherApps:YES];
    [alert runModal];
}

- (void)launchBrowserAtURL:(NSURL *)applicationURL arguments:(NSArray<NSString *> *)arguments {
    NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
    configuration.arguments = arguments;
    configuration.activates = YES;
    [NSWorkspace.sharedWorkspace openApplicationAtURL:applicationURL configuration:configuration
        completionHandler:^(__unused NSRunningApplication *application, NSError *launchError) {
            dispatch_async(dispatch_get_main_queue(), ^{
                self.preparingBrowser = NO;
                [self refreshMenu];
                if (launchError) [self showBrowserError:launchError.localizedDescription];
            });
        }];
}

- (void)prepareBrowser:(id)sender {
    [self prepareBrowserRequiringConfirmation:YES];
}

- (void)prepareBrowserRequiringConfirmation:(BOOL)requiresConfirmation {
    if (self.preparingBrowser) return;
    NSDictionary *status = C8KBrowserStatus();
    BOOL alreadyReady = [status[@"captureModeReady"] boolValue];
    NSArray<NSString *> *launchArguments = C8KChromeLaunchArguments(status);

    NSURL *applicationURL = nil;
    NSString *applicationPath = status[@"applicationPath"];
    if (applicationPath.length > 0) applicationURL = [NSURL fileURLWithPath:applicationPath isDirectory:YES];
    if (!applicationURL) {
        applicationURL = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:@"com.google.Chrome"];
    }
    if (!applicationURL) {
        [self showBrowserError:@"Google Chrome n’est pas installé dans Applications."];
        return;
    }

    if ([status[@"running"] boolValue]) {
        if (requiresConfirmation) {
        NSAlert *confirmation = [NSAlert new];
        confirmation.messageText = alreadyReady
            ? @"Recharger la nouvelle version de Capture8K ?"
            : @"Activer le mode fidèle de Capture8K ?";
        confirmation.informativeText = alreadyReady
            ? @"Capture8K va fermer puis rouvrir Chrome avec la dernière session et charger le nouveau moteur qui conserve le zoom et le viewport de chaque site. Enregistre d’abord tout formulaire en cours."
            : @"Capture8K va fermer puis rouvrir Chrome en restaurant la dernière session. L’agent Capture8K vérifiera ensuite automatiquement ce mode à chaque nouveau lancement. Enregistre d’abord tout formulaire en cours. Le mode masque aussi la barre de débogage des extensions : conserve uniquement des extensions de confiance.";
        [confirmation addButtonWithTitle:@"Relancer Chrome"];
        [confirmation addButtonWithTitle:@"Annuler"];
        [NSApp activateIgnoringOtherApps:YES];
        if ([confirmation runModal] != NSAlertFirstButtonReturn) return;
        }

        NSNumber *processIdentifier = status[@"processIdentifier"];
        NSRunningApplication *browser = processIdentifier
            ? [NSRunningApplication runningApplicationWithProcessIdentifier:processIdentifier.intValue] : nil;
        self.preparingBrowser = YES;
        [self refreshMenu];
        if (browser && ![browser terminate]) {
            self.preparingBrowser = NO;
            [self refreshMenu];
            [self showBrowserError:@"Chrome n’a pas accepté la fermeture. Ferme-le manuellement, puis choisis « Ouvrir Chrome en mode Capture8K »."];
            return;
        }
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:8.0];
        while (browser && !browser.terminated && deadline.timeIntervalSinceNow > 0) {
            [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        }
        if (browser && !browser.terminated) {
            self.preparingBrowser = NO;
            [self refreshMenu];
            [self showBrowserError:@"Chrome est encore ouvert. Ferme-le manuellement, puis recommence."];
            return;
        }
    } else {
        self.preparingBrowser = YES;
        [self refreshMenu];
    }
    [self launchBrowserAtURL:applicationURL arguments:launchArguments];
}

- (void)updateResolution:(NSString *)resolution {
    NSMutableDictionary *settings = [C8KLoadSettings() mutableCopy];
    settings[@"resolution"] = resolution;
    C8KSaveSettings(settings, nil);
    [NSDistributedNotificationCenter.defaultCenter postNotificationName:C8KSettingsChangedNotification
        object:nil userInfo:nil deliverImmediately:YES];
    [self refreshMenu];
}

- (void)select4K:(id)sender { [self updateResolution:@"4k"]; }
- (void)select8K:(id)sender { [self updateResolution:@"8k"]; }

- (void)requestCapture:(id)sender {
    [NSDistributedNotificationCenter.defaultCenter postNotificationName:C8KCaptureRequestedNotification
        object:nil userInfo:nil deliverImmediately:YES];
}

- (void)chooseFolder:(id)sender {
    if (self.folderPanelVisible) return;
    self.folderPanelVisible = YES;
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.title = @"Choisir où enregistrer les captures";
    panel.prompt = @"Choisir";
    panel.canChooseDirectories = YES;
    panel.canChooseFiles = NO;
    panel.allowsMultipleSelection = NO;
    panel.directoryURL = [NSURL fileURLWithPath:C8KLoadSettings()[@"outputDirectory"] isDirectory:YES];
    [NSApp activateIgnoringOtherApps:YES];
    NSModalResponse response = [panel runModal];
    if (response == NSModalResponseOK && panel.URL) {
        NSMutableDictionary *settings = [C8KLoadSettings() mutableCopy];
        settings[@"outputDirectory"] = panel.URL.path;
        settings[@"outputMode"] = @"custom";
        C8KSaveSettings(settings, nil);
        [NSDistributedNotificationCenter.defaultCenter postNotificationName:C8KSettingsChangedNotification
            object:nil userInfo:nil deliverImmediately:YES];
        [self refreshMenu];
    }
    self.folderPanelVisible = NO;
}

- (void)revealFolder:(id)sender {
    NSURL *directory = [NSURL fileURLWithPath:C8KLoadSettings()[@"outputDirectory"] isDirectory:YES];
    [NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:nil];
    [NSWorkspace.sharedWorkspace openURL:directory];
}

- (void)showAbout:(id)sender {
    NSAlert *alert = [NSAlert new];
    alert.messageText = [NSString stringWithFormat:@"Capture8K %@",
        NSBundle.mainBundle.infoDictionary[@"CFBundleShortVersionString"] ?: @""];
    alert.informativeText = @"Dans Chrome ou Firefox, ⌘⇧8 capture 100 % de la zone web visible en 4K/8K. Firefox utilise directement le rerendu natif haute densité de Gecko ; Chrome conserve son mode fidèle. L’app compare plusieurs témoins visuels avant d’enregistrer le PNG.";
    [alert addButtonWithTitle:@"OK"];
    [NSApp activateIgnoringOtherApps:YES];
    [alert runModal];
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc > 1 && strcmp(argv[1], "--request-capture") == 0) {
            [NSDistributedNotificationCenter.defaultCenter postNotificationName:C8KCaptureRequestedNotification
                object:nil userInfo:nil deliverImmediately:YES];
            return 0;
        }
        if (argc > 1 && strcmp(argv[1], "--prepare-browser") == 0) {
            [NSDistributedNotificationCenter.defaultCenter postNotificationName:C8KPrepareBrowserNotification
                object:nil userInfo:nil deliverImmediately:YES];
            return 0;
        }
        if (argc > 1 && strcmp(argv[1], "--prepare-browser-direct") == 0) {
            return C8KPrepareBrowserDirectly();
        }
        if (argc > 1 && strcmp(argv[1], "--choose-folder") == 0) {
            [NSDistributedNotificationCenter.defaultCenter postNotificationName:C8KChooseFolderNotification
                object:nil userInfo:nil deliverImmediately:YES];
            return 0;
        }
        NSApplication *application = NSApplication.sharedApplication;
        Capture8KApplicationDelegate *delegate = [Capture8KApplicationDelegate new];
        application.delegate = delegate;
        [application run];
    }
    return 0;
}
