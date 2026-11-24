import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// 正式版的签名：android/keystore.properties（不入库）指向签名文件和口令，见 docs/08。
// App 内升级要求新旧安装包签名一样，所以一直用同一个签名文件；没有这个配置时退回调试签名
val releaseKeystore = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// 服务器地址不写进 App：调试版和正式版的登录页都有"服务器地址"框，填过的地址存在手机上，设置里可以改（docs/08 第 1 节）

android {
    namespace = "com.remoteclaude.android"
    compileSdk = 36
    buildToolsVersion = "35.0.1"

    defaultConfig {
        applicationId = "com.remoteclaude.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 20
        versionName = "0.9.8"
        // 只打包 64 位 ARM 和模拟器用的 x86_64，WebRTC 的原生库很大
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }

    signingConfigs {
        if (!releaseKeystore.isEmpty) {
            create("release") {
                storeFile = rootProject.file(releaseKeystore.getProperty("storeFile"))
                storePassword = releaseKeystore.getProperty("storePassword")
                keyAlias = releaseKeystore.getProperty("keyAlias")
                keyPassword = releaseKeystore.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            // 调试版允许 ws:// 明文连接，方便连局域网或模拟器里的本机服务器
            buildConfigField("boolean", "ALLOW_CLEARTEXT", "true")
            applicationIdSuffix = ".debug"
        }
        release {
            buildConfigField("boolean", "ALLOW_CLEARTEXT", "false")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (releaseKeystore.isEmpty) signingConfigs.getByName("debug") else signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        // Android 15 起部分设备用 16 KB 内存页，原生库不压缩存放才能按页对齐直接映射
        jniLibs { useLegacyPackaging = false }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.fragment.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.biometric)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.webrtc)

    testImplementation(libs.junit)
}
