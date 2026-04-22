#import "ObjCExceptionBridge.h"

@implementation ObjCExceptionBridge

+ (BOOL)catching:(__attribute__((noescape)) void (^)(void))block
           error:(NSError * _Nullable __autoreleasing * _Nullable)error {
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        if (error) {
            NSMutableDictionary *info = [NSMutableDictionary dictionary];
            info[NSLocalizedDescriptionKey] = exception.reason ?: exception.name ?: @"Obj-C exception";
            info[@"ExceptionName"] = exception.name ?: @"";
            if (exception.userInfo) {
                info[@"ExceptionUserInfo"] = exception.userInfo;
            }
            *error = [NSError errorWithDomain:@"ObjCExceptionBridge" code:0 userInfo:info];
        }
        return NO;
    }
}

@end
