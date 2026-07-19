# The messaging service and the receiver are instantiated by the framework from
# their manifest names, so R8 cannot see any caller and would otherwise strip
# them — leaving an app that builds cleanly and never rings.
-keep class com.gians.app.CallMessagingService { *; }
-keep class com.gians.app.CallActionReceiver { *; }
-keep class com.gians.app.IncomingCallActivity { *; }
-keep class com.gians.app.GiansLauncherActivity { *; }

-keepnames class com.google.androidbrowserhelper.** { *; }
