package database
import(
	"context"
	"log"
	"os"
	"github.com/jackc/pgx/v5/pgxpool"
)

var DB *pgxpool.Pool
func Connect(){
	var err error
	connStr := os.Getenv("DATABASE_URL")
	if connStr == ""{
		log.Fatal("DATABASE_URL environment variable is not set")
	}
	
	DB,err = pgxpool.New(context.Background(),connStr)
	if err != nil {
		log.Fatalf("Unable to connect to database: %v\n", err)
	}
	if err := DB.Ping(context.Background());err !=nil{
		log.Fatalf("unable to ping databese:%v\n",err)
	}

	log.Printf("successfully connected to databse\n")
}

