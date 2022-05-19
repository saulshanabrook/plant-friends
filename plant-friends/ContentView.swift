//
//  ContentView.swift
//  plant-friends
//
//  Created by Saul Shanabrook on 5/1/22.
//

import SwiftUI

struct ContentView: View {
    @State var searchQuery = ""
    @StateObject var resp = res;
    var body: some View {
        switch resp.completion {
        case .failure(let error):
            ScrollView{
                VStack{
                    Text("Loading Error:").font(.title)
                    Divider()
                    Text(String(describing: error))
                        .font(.system(.footnote, design: .monospaced))
                }.padding()
            }
            Text("Error loading data \(error)" as String)
        default:
            switch resp.value {
            case nil:
                ProgressView()
            default:
                NavigationView {
                    ListView(plants: resp.value!, searchQuery: searchQuery)
                }
                .searchable(text: $searchQuery,
                  prompt: "Search plants")
                .disableAutocorrection(true)

            }
        }
        
    }
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
