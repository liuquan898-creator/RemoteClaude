# WebRTC 的 Java 层大量通过 JNI 按名字回调，混淆或裁剪后会在运行时崩溃
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# OkHttp 引用了不一定存在的可选依赖
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
