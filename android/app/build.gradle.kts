// Imported explicitly: inside the Kotlin DSL, `java` resolves to Gradle's java
// extension and shadows the package, so `java.net.URI` does not compile.
import java.net.URI

plugins {
    id("com.android.application")
    id("com.google.gms.google-services")
}

val hostUrl: String = providers.gradleProperty("GIANS_HOST_URL").get()
val appId: String = providers.gradleProperty("GIANS_APPLICATION_ID").get()

android {
    namespace = "com.gians.app"
    compileSdk = 36

    defaultConfig {
        applicationId = appId
        // 26 is the floor for adaptive icons and for setShowWhenLocked, which
        // saves carrying a second code path purely for devices that are now
        // eight years old.
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        buildConfigField("String", "HOST_URL", "\"$hostUrl\"")
        // The TWA manifest entries need the URL too, and manifest placeholders
        // are the only way to get a Gradle value into AndroidManifest.xml.
        manifestPlaceholders["hostUrl"] = hostUrl
        manifestPlaceholders["hostName"] = URI(hostUrl).host
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            // Debug and release sign with different certificates, so both
            // fingerprints have to appear in assetlinks.json for either to run
            // without a URL bar.
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
}

dependencies {
    // Trusted Web Activity host. android-browser-helper supplies LauncherActivity;
    // androidx.browser alone does not.
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.6.2")

    // NotificationCompat.CallStyle lives here (present since 1.9.0).
    // Pinned to 1.18.0 deliberately: 1.19.0 requires compileSdk 37, which is not
    // yet in the stable SDK channel. Bump both together, not this alone.
    implementation("androidx.core:core:1.18.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("com.google.android.material:material:1.13.0")
    implementation("androidx.constraintlayout:constraintlayout:2.2.1")

    implementation(platform("com.google.firebase:firebase-bom:34.16.0"))
    implementation("com.google.firebase:firebase-messaging")
}
