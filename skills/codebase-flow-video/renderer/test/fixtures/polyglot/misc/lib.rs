fn main() { let v = parse("1"); if v > 0 { run(v); } }
fn parse(s: &str) -> i32 { match s { "1" => 1, _ => 0 } }
fn run(v: i32) {}
