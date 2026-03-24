# NEXUSGRAM SANDBOX 🔬

**Status:** Experimental Development Environment
**Bot:** @NexusOneDevBot
**Purpose:** Safe testing ground for multi-model routing and experimental features

---

## 🎯 PURPOSE

Nexusgram is a **sandbox fork** of Claudegram for testing experimental features before production deployment.

**Key Differences from Production:**
- Different Telegram bot (@NexusOneDevBot vs @AstronOneBot)
- Separate session storage (~/.nexusgram vs ~/.claudegram)
- Separate logs (nexusgram-dev.log vs claudegram-stable.log)
- Experimental features enabled (Ollama, multi-model routing)

---

## 🚀 QUICK START

### Start Sandbox Bot
```bash
cd /Users/ashtron/Documents/NEXUS/PROJECT_MODULES/Mac_Mini_AI_Server/nexusgram
nohup bash start-sandbox.sh > /dev/null 2>&1 &
```

### Stop Sandbox Bot
```bash
pkill -f "start-sandbox.sh"
pkill -f "nexusgram.*node"
rm -f /tmp/nexusgram-sandbox.lock
```

### Check Status
```bash
ps aux | grep nexusgram
tail -f ~/Library/Logs/nexusgram-dev.log
```

---

## 📋 CONFIGURATION

**Environment:** `.env.sandbox`

**Key Settings:**
- `TELEGRAM_BOT_TOKEN`: @NexusOneDevBot token
- `CLAUDE_SESSION_DIR`: ~/.nexusgram (separate from production)
- `OLLAMA_ENABLED`: false (can be enabled for testing)
- `ROUTING_STRATEGY`: cloud-only (can test auto-routing)
- `LOG_LEVEL`: debug (more verbose than production)

---

## 🧪 EXPERIMENTAL FEATURES

### Ready to Test
1. ✅ Enhanced Session UI (already integrated)
   - Precise timestamps (5m 23s ago)
   - Message counts
   - Session previews

### Planned for Testing
2. ⏳ Multi-Model Routing
   - Ollama integration (Qwen 2.5 14B)
   - Automatic routing logic
   - Quality monitoring

3. ⏳ Agent Tunnel Management
   - Model locking
   - Context preservation
   - Delegation tracking

4. ⏳ UI Improvements
   - Menu system enhancements
   - Settings persistence
   - Command aliases

---

## 🔄 WORKFLOW

**Development Cycle:**
1. **Develop** in Nexusgram sandbox
2. **Test** with @NexusOneDevBot
3. **Validate** for 1-2 weeks
4. **Port** stable features to Claudegram production
5. **Deploy** to @AstronOneBot

**Safety Rules:**
- ✅ Production (Claudegram) stays untouched
- ✅ All experiments in sandbox first
- ✅ No breaking changes without testing
- ✅ Git branch: sandbox/nexusgram-development

---

## 📊 CONFLICT PREVENTION

**How Sandbox Avoids Production Conflicts:**

| Aspect | Production | Sandbox |
|--------|-----------|---------|
| Bot | @AstronOneBot | @NexusOneDevBot |
| Token | 8670334761:... | 8648593082:... |
| Directory | claudegram/ | nexusgram/ |
| Sessions | ~/.claudegram/ | ~/.nexusgram/ |
| Logs | claudegram-stable.log | nexusgram-dev.log |
| Lock File | /tmp/claudegram-stable.lock | /tmp/nexusgram-sandbox.lock |
| Git Branch | fix/mac-mini-m4pro... | sandbox/nexusgram-development |
| Ollama | Disabled | Can enable |

**Result:** ✅ Zero interference possible

---

## 🛠️ MAINTENANCE

### Sync Latest Code from Production
```bash
cd nexusgram
git checkout sandbox/nexusgram-development
git merge fix/mac-mini-m4pro-deployment-reliability
```

### Port Tested Features to Production
```bash
# After feature proven stable in sandbox
cd ../claudegram
# Manual code port or cherry-pick specific commits
```

### Reset Sandbox (if needed)
```bash
rm -rf nexusgram
cp -r claudegram nexusgram
cd nexusgram
git checkout -b sandbox/nexusgram-development
# Restore .env.sandbox
```

---

## 📝 TESTING CHECKLIST

Before porting features to production:

- [ ] Feature works in sandbox for 1+ week
- [ ] No critical bugs or crashes
- [ ] User acceptance (Arash approved)
- [ ] Performance metrics acceptable
- [ ] Documentation updated
- [ ] Code reviewed

---

## 🚨 TROUBLESHOOTING

### Bot Won't Start
```bash
# Check lock file
ls -la /tmp/nexusgram-sandbox.lock
# Remove if stale
rm -f /tmp/nexusgram-sandbox.lock

# Check logs
tail -50 ~/Library/Logs/nexusgram-dev.log
```

### Multiple Instances Running
```bash
# Kill all
pkill -9 -f "nexusgram"
rm -f /tmp/nexusgram-sandbox.lock
sleep 70  # Wait for clean shutdown
```

### Session Conflicts
```bash
# Sessions stored separately, no conflict possible
ls -la ~/.claudegram/  # Production
ls -la ~/.nexusgram/   # Sandbox
```

---

## 📚 RELATED DOCS

- [Nexusgram Sandbox Setup Plan](../../NEXUS_LAB/01_RESEARCH_POOL/NEXUSGRAM_SANDBOX_SETUP_PLAN_2026-03-01.md)
- [Mac Mini Master Plan Session](../../99_META/SESSIONS/2026-03-01_MAC_MINI_MASTER_PLAN_SESSION.md)
- [Multi-Model Architecture Plan](../../NEXUS_LAB/01_RESEARCH_POOL/) (from research agent)

---

**Created:** 2026-03-01
**Status:** ✅ Ready for Testing
**Next:** Start bot and test with @NexusOneDevBot
