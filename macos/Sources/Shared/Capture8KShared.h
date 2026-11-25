#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

extern NSNotificationName const C8KSettingsChangedNotification;
extern NSNotificationName const C8KCaptureRequestedNotification;
extern NSNotificationName const C8KPrepareBrowserNotification;
extern NSNotificationName const C8KChooseFolderNotification;

NSDictionary *C8KDefaultSettings(void);
NSDictionary *C8KLoadSettings(void);
BOOL C8KSaveSettings(NSDictionary *settings, NSError **error);
NSURL *C8KSettingsURL(void);
NSString *C8KSanitizedFilename(NSString *filename);
NSURL *C8KUniqueDestination(NSURL *directory, NSString *filename);
NSDictionary *C8KBrowserStatus(void);
BOOL C8KInstallPersistentCaptureMode(NSString *bundleIdentifier, NSError **error);
BOOL C8KPersistentCaptureModeConfigured(NSString *bundleIdentifier);
BOOL C8KInstallCreatorBridge(NSError **error);

NS_ASSUME_NONNULL_END
