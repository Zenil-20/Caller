// Kotlin support is built into AGP from 9.0 onward — applying
// org.jetbrains.kotlin.android alongside it is now a hard error, not a warning.
plugins {
    id("com.android.application") version "9.3.0" apply false
    id("com.google.gms.google-services") version "4.4.4" apply false
}
