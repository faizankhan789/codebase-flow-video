public class Ctl {
  [HttpGet("/items")]
  public string List() { return Fetch(); }
  private string Fetch() { try { return "x"; } catch { return ""; } }
}
