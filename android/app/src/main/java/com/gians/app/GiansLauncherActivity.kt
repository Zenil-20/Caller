package com.gians.app

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.google.androidbrowserhelper.trusted.LauncherActivity
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Launches the web app inside a Trusted Web Activity, and is the one place that
 * bridges native state into it.
 *
 * The FCM token is appended to the launch URL rather than registered natively.
 * That keeps every credential out of this shell: it never sees a password or an
 * access token and needs no login screen, because the page it opens is already
 * signed in and can register the token against that session itself.
 */
class GiansLauncherActivity : LauncherActivity() {

    /**
     * Hold the launch until the FCM token is in hand.
     *
     * getLaunchingUrl() is called from super.onCreate(), so launching
     * immediately would build the URL before the token existed. On a fresh
     * install that means the very first run — the one where the user signs in —
     * registers no device, and calls do not ring until the app happens to be
     * opened a second time.
     */
    override fun shouldLaunchImmediately(): Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ensureNotificationPermission()

        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token -> if (token != null) TokenStore.save(this, token) }
            // Completion, not success: with no network or no Play Services this
            // fails, and the app still has to open. A launcher that waits for a
            // token that is never coming is a launcher that never opens.
            .addOnCompleteListener { launchTwa() }
    }

    override fun getLaunchingUrl(): Uri {
        val builder = super.getLaunchingUrl().buildUpon()

        TokenStore.get(this)?.let { builder.appendQueryParameter("fcmToken", it) }
        builder.appendQueryParameter("appVersion", BuildConfig.VERSION_NAME)

        // Set when the user answered from the call screen: the web app reads
        // these and picks the call up as soon as signalling reconnects.
        intent?.getStringExtra(EXTRA_CALL_ID)?.let {
            builder.appendQueryParameter("callId", it)
            builder.appendQueryParameter("action", intent.getStringExtra(EXTRA_ACTION) ?: "open")
        }

        return builder.build()
    }

    /**
     * Android 13+ will not show any notification without this, which would take
     * the call screen down with it — the full-screen intent rides on a
     * notification.
     */
    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    /**
     * Sideloaded builds keep USE_FULL_SCREEN_INTENT, but an OEM or a later Play
     * install can still revoke it — in which case calls silently degrade to a
     * banner. Worth sending the user straight to the setting rather than leaving
     * them to wonder why the call screen stopped appearing.
     */
    fun openFullScreenIntentSettingsIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.canUseFullScreenIntent()) return

        startActivity(
            Intent(
                Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                Uri.parse("package:$packageName"),
            )
        )
    }

    companion object {
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_ACTION = "action"
    }
}
