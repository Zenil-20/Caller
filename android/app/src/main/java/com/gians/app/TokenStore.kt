package com.gians.app

import android.content.Context

/**
 * Holds the FCM registration token between the messaging service that receives
 * it and the launcher that hands it to the web page.
 *
 * The token arrives asynchronously and often while no Activity is running, so it
 * cannot simply be passed in memory. It is not a credential — it identifies a
 * device to Firebase, nothing more — so plain SharedPreferences is the right
 * weight of storage for it.
 */
object TokenStore {
    private const val PREFS = "gians_prefs"
    private const val KEY_TOKEN = "fcm_token"

    fun save(context: Context, token: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_TOKEN, token)
            .apply()
    }

    fun get(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null)
}
