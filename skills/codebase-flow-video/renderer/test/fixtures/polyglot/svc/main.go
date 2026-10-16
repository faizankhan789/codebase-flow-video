package main

import (
	"net/http"

	"example.com/svc/store"
)

func handleUser(w http.ResponseWriter, r *http.Request) {
	u, err := store.Find(r.URL.Query().Get("id"))
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}
	w.Write([]byte(u))
}

func main() {
	http.HandleFunc("/user", handleUser)
	http.ListenAndServe(":8080", nil)
}
