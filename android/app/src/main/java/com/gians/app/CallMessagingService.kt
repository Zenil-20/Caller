package com.gians.app

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives the server's high-priority data messages.
 *
 * The server deliberately sends data-only payloads. A message carrying a
 * `notification` block would be rendered by the Firebase SDK itself whenever the
 * app is backgrounded, and this method would never run — which is precisely the
 * case that matters, since a closed app is the whole reason this exists.
 *
 * The budget here is a few seconds, so everything needed to ring is already in
 * the payload and nothing is fetched over the network first.
 */
class CallMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        // Registration happens from the web page on next launch; all this needs
        // to do is make sure the fresh token is what gets handed over.
        TokenStore.save(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val callId = data["callId"] ?: return

        when (data["type"]) {
            "incoming-call" -> {
                // The call may have been answered on another device while the
                // message sat in the push queue. Ringing now would be worse than
                // not ringing at all.
                val expiresAt = data["expiresAt"]?.toLongOrNull()
                if (expiresAt != null && System.currentTimeMillis() > expiresAt) return

                CallNotifier.showIncomingCall(
                    context = this,
                    callId = callId,
                    callerName = data["callerName"] ?: "Unknown caller",
                    callerUsername = data["callerUsername"].orEmpty(),
                    actionToken = data["actionToken"].orEmpty(),
                    expiresAt = expiresAt,
                )
            }

            "call-cancelled" -> CallNotifier.cancel(this, callId)

            "missed-call" -> {
                CallNotifier.cancel(this, callId)
                CallNotifier.showMissedCall(this, callId, data["callerName"] ?: "Someone")
            }
        }
    }
}
