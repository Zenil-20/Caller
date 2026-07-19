package com.gians.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * Declines a call straight from the notification, without opening the app.
 *
 * It authenticates with the short-lived action token that arrived inside the
 * push payload, so this works on a locked phone where no session exists — the
 * same endpoint and the same token the browser's service worker uses.
 *
 * HttpURLConnection rather than a HTTP client library: this is one POST, and an
 * extra dependency would be more bytes in the APK than the whole feature.
 */
class CallActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DECLINE) return

        val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return
        val actionToken = intent.getStringExtra(EXTRA_ACTION_TOKEN).orEmpty()

        CallNotifier.cancel(context, callId)
        declineInBackground(context.applicationContext, callId, actionToken)
    }

    companion object {
        const val ACTION_DECLINE = "com.gians.app.DECLINE"
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_ACTION_TOKEN = "actionToken"

        private val executor = Executors.newSingleThreadExecutor()

        /**
         * Fire-and-forget. If it fails the call simply rings out and is recorded
         * as missed, exactly as it would if the phone had been out of signal —
         * so there is nothing worth blocking or retrying for.
         */
        fun declineInBackground(context: Context, callId: String, actionToken: String) {
            if (actionToken.isEmpty()) return

            executor.execute {
                var connection: HttpURLConnection? = null
                try {
                    val url = URL("${BuildConfig.HOST_URL.trimEnd('/')}/api/push/call-action")
                    connection = (url.openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"
                        setRequestProperty("Content-Type", "application/json")
                        doOutput = true
                        connectTimeout = 10_000
                        readTimeout = 10_000
                    }

                    val body = JSONObject()
                        .put("actionToken", actionToken)
                        .put("action", "reject")
                        .toString()

                    OutputStreamWriter(connection.outputStream).use { it.write(body) }

                    // Reading the status is what actually flushes the request.
                    Log.d(TAG, "Decline for $callId returned ${connection.responseCode}")
                } catch (err: Exception) {
                    Log.w(TAG, "Decline for $callId failed: ${err.message}")
                } finally {
                    connection?.disconnect()
                }
            }
        }

        private const val TAG = "GiansCallAction"
    }
}
