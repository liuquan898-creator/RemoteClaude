import groovy.json.JsonSlurper
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

// 自己的服务器地址不写在仓库里，从本机的打包配置读：仓库根目录的 deploy/prod/build.json（不入库，
// 环境变量 RC_BUILD_CONFIG 可以指到别的文件），样例见 deploy/build.example.json，和被控端打包读的是同一个文件。
// 配了 server：地址写进 App，正式版登录页不显示地址框。没配：正式版登录页也显示"服务器地址"框，自己填
val serverAddress: String = run {
    val f = System.getenv("RC_BUILD_CONFIG")?.takeIf { it.isNotBlank() }?.let { file(it) }
        ?: rootProject.file("../deploy/prod/build.json")
    val json = if (f.exists()) JsonSlurper().parse(f) as? Map<*, *> else null
    (json?.get("server") as? String).orEmpty().trim()
}
require(serverAddress.none { it == '"' || it == '\\' }) { "打包配置里的 server 不能带引号或反斜杠: $serverAddress" }

android {
    namespace = "com.remoteclaude.android"
    compileSdk = 36
    buildToolsVersion = "35.0.1"

    defaultConfig {
        applicationId = "com.remoteclaude.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 19
        versionName = "0.9.7"
        // 打包配置里的服务器地址（见上面），没配是空字符串
        buildConfigField("String", "SERVER_ADDRESS", "\"$serverAddress\"")
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
            // 调试版允许 ws:// 明文连接、允许改服务器地址，方便连局域网或模拟器里的本机服务器
            buildConfigField("boolean", "ALLOW_CLEARTEXT", "true")
            buildConfigField("boolean", "SERVER_EDITABLE", "true")
            applicationIdSuffix = ".debug"
        }
        release {
            buildConfigField("boolean", "ALLOW_CLEARTEXT", "false")
            // 写进了服务器地址就不让改；没写就得让用户自己填
            buildConfigField("boolean", "SERVER_EDITABLE", if (serverAddress.isEmpty()) "true" else "false")
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
