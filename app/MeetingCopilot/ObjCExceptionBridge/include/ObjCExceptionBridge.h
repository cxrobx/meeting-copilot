#ifndef OBJC_EXCEPTION_BRIDGE_H
#define OBJC_EXCEPTION_BRIDGE_H

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// Lets Swift catch Obj-C NSExceptions raised by AVFoundation / CoreAudio APIs
// (e.g. AVAudioNode -installTapOnBus:bufferSize:format: raises a format-mismatch
// NSException during device transitions, which Swift cannot catch with do/try
// and therefore terminates the process). Wrap the offending call in a block
// passed to +catching:error:; on exception the call returns NO and populates
// `error` with the exception's reason / name / userInfo.
//
// Method named `catching:error:` instead of `tryBlock:error:` because Swift's
// importer renames `try`-prefixed selectors and would force the call site to
// use awkward backticks (`ObjCExceptionBridge.\`try\` { ... }`).
@interface ObjCExceptionBridge : NSObject

+ (BOOL)catching:(__attribute__((noescape)) void (^)(void))block
           error:(NSError * _Nullable __autoreleasing * _Nullable)error;

@end

NS_ASSUME_NONNULL_END

#endif /* OBJC_EXCEPTION_BRIDGE_H */
