try {
  $r = Invoke-RestMethod "http://127.0.0.1:8000/api/xiaozhi/say" -Method Post -ContentType "application/json" -Body '{"text":"测试"}' -TimeoutSec 20
  "say ok=$($r.ok)"
} catch {
  "say HTTP $($_.Exception.Response.StatusCode.value__) : $($_.ErrorDetails.Message)"
}
